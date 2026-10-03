// The registry's own checks, CC0-1.0 like everything else here.
//
// inGitDB validates the records against the collection definitions (types,
// required columns, enums, lengths, foreign keys). This module checks what a
// column definition cannot say, and everything that needs the graph's own
// repository: it fetches each graph at its commit, finds its files, runs the
// meaning checker of meaninggraph/core over its meaning files, and compares
// licences, addresses and dependency pins with what the files declare.
//
// The meaning checker is not copied here. It is scripts/lib/meaning.mjs of
// meaninggraph/core at the commit the registry's own `core` record names, so a
// pull request that moves core moves the checker with it (loadChecker).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const registryFormat = 'meaning-registry/draft-1';
// The graph whose commit supplies the meaning-file schema and the checker.
export const checkerGraph = 'core';
export const checkerRepository = 'https://github.com/meaninggraph/core';

// Same rule as the record contract the planned search index uses: lower case,
// digits and single hyphens, at most 80 characters.
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const commitPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)((?:\/[A-Za-z0-9_.-]+){2,})$/;
const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
// A path inside the repository: relative, no "..", and `*` matches within one
// path segment only (so `*.meaning.yaml` means the repository root).
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.*\/-]+$/;

const git = (args, options = {}) => execFileSync('git', args, { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options }).toString();
const lastLine = (error) => String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).pop() ?? 'failed';

const recordsDir = (root, collection) => join(root, collection, '$records');

// Reads one collection's records as [{ key, file, data }] sorted by key, with a
// problem for any file in $records that is not <key>.yaml.
export function readCollection(root, collection) {
  const dir = recordsDir(root, collection);
  const records = [];
  const problems = [];
  if (!existsSync(dir)) return { records, problems };
  for (const name of readdirSync(dir).sort()) {
    const file = `${collection}/$records/${name}`;
    if (!name.endsWith('.yaml')) { problems.push(`${file}: a record is a <key>.yaml file; remove or rename it`); continue; }
    let data;
    try { data = parseYaml(readFileSync(join(dir, name), 'utf8')); } catch (error) { problems.push(`${file}: not YAML: ${error.message}`); continue; }
    records.push({ key: name.slice(0, -'.yaml'.length), file, data: data ?? {} });
  }
  return { records, problems };
}

export function readRegistry(root) {
  const graphs = readCollection(root, 'graphs');
  const dependencies = readCollection(root, 'dependencies');
  const maintainers = readCollection(root, 'maintainers');
  return {
    graphs: graphs.records,
    dependencies: dependencies.records,
    maintainers: maintainers.records,
    problems: [...graphs.problems, ...dependencies.problems, ...maintainers.problems],
  };
}

// meaning://{host}/{path} for https://{host}/{path}, or null.
export function addressOf(repository) {
  const match = repositoryPattern.exec(repository ?? '');
  return match ? `meaning://${match[1]}${match[2]}` : null;
}

// Rules on the records alone (no network): the parts of the format that the
// inGitDB collection definitions cannot express.
export function recordProblems({ graphs, dependencies }) {
  const problems = [];
  const byAddress = new Map();
  const byRepository = new Map();
  const ids = new Set(graphs.map((graph) => graph.key));
  for (const { key, file, data } of graphs) {
    if (!idPattern.test(key) || key.length > 80) problems.push(`${file}: id "${key}" must be lower-case letters, digits and single hyphens, at most 80 characters`);
    if (!commitPattern.test(data.commit ?? '')) problems.push(`${file}: commit must be a full 40-character lower-case commit id`);
    const address = addressOf(data.repository);
    if (!address) problems.push(`${file}: repository must be an https URL of a repository, such as https://github.com/{org}/{repo} (no trailing slash or .git)`);
    else if (data.address !== address) problems.push(`${file}: address must be ${address}, the meaning:// form of the repository (draft-1 registers one graph per repository)`);
    for (const [map, value] of [[byAddress, data.address], [byRepository, data.repository]]) {
      if (value !== undefined) map.set(value, [...(map.get(value) ?? []), { key, file }]);
    }
    for (const column of ['meaning_licence', 'model_licence']) {
      if (data[column] !== undefined && !spdxPattern.test(data[column])) problems.push(`${file}: ${column} must be an SPDX licence identifier`);
    }
    for (const column of ['meaning_files', 'model_files']) {
      for (const path of data[column] ?? []) {
        if (typeof path !== 'string' || !pathPattern.test(path)) problems.push(`${file}: ${column}: "${path}" must be a relative path inside the repository (no "..", * only within one path segment)`);
      }
    }
    for (const path of data.meaning_files ?? []) {
      if (typeof path === 'string' && !path.endsWith('.meaning.yaml')) problems.push(`${file}: meaning_files: "${path}" must name *.meaning.yaml files`);
    }
    if (data.kind === 'universal' && data.model_files) problems.push(`${file}: a universal graph has no model files; models belong to dataset graphs`);
  }
  for (const [map, what] of [[byAddress, 'address'], [byRepository, 'repository']]) {
    for (const [value, owners] of map) {
      if (owners.length > 1) problems.push(`${owners.at(-1).file}: ${what} ${value} is registered under ${owners.length} ids (${owners.map((owner) => owner.key).join(', ')}); a graph is registered once`);
    }
  }
  for (const { key, file, data } of dependencies) {
    if (key !== `${data.graph}--${data.depends_on}`) problems.push(`${file}: the key must be ${data.graph}--${data.depends_on} (<graph>--<depends_on>)`);
    if (data.graph === data.depends_on) problems.push(`${file}: a graph cannot depend on itself`);
    if (!ids.has(data.graph)) problems.push(`${file}: graph ${data.graph} is not registered`);
    if (!ids.has(data.depends_on)) problems.push(`${file}: depends_on ${data.depends_on} is not registered`);
    if (!commitPattern.test(data.commit ?? '')) problems.push(`${file}: commit must be a full 40-character lower-case commit id`);
  }
  return problems;
}

// Fetches one commit of a repository into cacheDir/<commit> (or reuses it when
// it is still exactly that commit). Used only to bootstrap the checker; graphs
// are fetched with the checker's own checkoutGit.
export function fetchCommit(url, commit, cacheDir) {
  const dir = join(cacheDir, commit);
  const at = (...args) => git(['--git-dir', join(dir, '.git'), '--work-tree', dir, ...args]).trim();
  try {
    if (existsSync(dir) && at('rev-parse', 'HEAD') === commit && at('status', '--porcelain', '--untracked-files=no') === '') return dir;
  } catch { /* not a usable checkout: fetch it again */ }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const work = mkdtempSync(join(cacheDir, '.fetch-'));
  try {
    git(['init', '-q', work]);
    git(['-C', work, 'fetch', '-q', '--depth', '1', url, commit]);
    git(['-C', work, 'checkout', '-q', 'FETCH_HEAD']);
    if (git(['-C', work, 'rev-parse', 'HEAD']).trim() !== commit) throw new Error('did not check out that commit');
    renameSync(work, dir);
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`cannot fetch ${commit} from ${url}: ${lastLine(error)}`);
  }
  return dir;
}

// Loads scripts/lib/meaning.mjs of the `core` record's commit, installing its
// locked dependencies (npm ci --ignore-scripts) on first use. Returns
// { meaning, dir, commit }.
export async function loadChecker({ root, graphs, urlFor = (url) => url, cacheDir = join(root, '.cache', 'checker') }) {
  const core = graphs.find((graph) => graph.key === checkerGraph);
  if (!core) throw new Error(`graphs/$records/${checkerGraph}.yaml is missing; the checker is read from that graph's commit`);
  const { repository, commit } = core.data;
  // The checker is code that CI runs, so it only ever comes from this repository.
  if (repository !== checkerRepository) throw new Error(`the ${checkerGraph} record must name ${checkerRepository}, where the checker lives, not ${repository}`);
  if (!commitPattern.test(commit ?? '')) throw new Error(`the ${checkerGraph} record's commit must be a full commit id`);
  const dir = fetchCommit(urlFor(repository), commit, cacheDir);
  const entry = join(dir, 'scripts', 'lib', 'meaning.mjs');
  if (!existsSync(entry)) throw new Error(`${repository} at ${commit} has no scripts/lib/meaning.mjs, so it cannot check meaning files`);
  if (!existsSync(join(dir, 'node_modules'))) execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], { cwd: dir, stdio: 'pipe' });
  return { meaning: await import(pathToFileURL(entry).href), dir, commit };
}

const globRegExp = (pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

// The tracked files of a checkout that each pattern matches: { files, missing }.
export function expandPaths(dir, patterns) {
  const tracked = git(['-C', dir, 'ls-files']).split('\n').filter(Boolean);
  const files = new Set();
  const missing = [];
  for (const pattern of patterns ?? []) {
    const matched = pattern.includes('*') ? tracked.filter((path) => globRegExp(pattern).test(path)) : tracked.filter((path) => path === pattern);
    if (matched.length === 0) missing.push(pattern);
    matched.forEach((path) => files.add(path));
  }
  return { files: [...files].sort(), missing };
}

// Licence texts the check recognises in a repository's LICENSE files.
const licenceTexts = [
  ['MIT', /^\s*MIT License/m],
  ['CC0-1.0', /CC0 1\.0 Universal/],
  ['Apache-2.0', /Apache License\s+Version 2\.0/],
  ['CC-BY-4.0', /Attribution 4\.0 International/],
  ['BSD-3-Clause', /BSD 3-Clause/],
];

// SPDX ids identified by the LICENSE* files in the repository root.
export function repositoryLicences(dir) {
  const found = new Set();
  for (const name of readdirSync(dir)) {
    if (!/^(LICEN[CS]E|COPYING)/i.test(name)) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const [id, pattern] of licenceTexts) if (pattern.test(text)) found.add(id);
  }
  return found;
}

// The licence a file states about itself: a meaning file's `license` field, or
// a `Licence:` / `License:` / `SPDX-License-Identifier:` line in its first lines.
export function declaredLicence(path, text, doc) {
  if (path.endsWith('.meaning.yaml') && typeof doc?.license === 'string') return doc.license;
  for (const line of text.split('\n').slice(0, 10)) {
    const match = /(?:SPDX-License-Identifier|Licen[cs]e):\s*([A-Za-z0-9][A-Za-z0-9.+-]*[A-Za-z0-9+])/i.exec(line);
    if (match) return match[1];
  }
  return null;
}

// A file's licence must be the one the entry states: the licence the file
// declares itself, or, when it declares none, one of the repository's LICENSE files.
function licenceProblems(file, dir, paths, expected, column) {
  const problems = [];
  const fromLicenseFiles = repositoryLicences(dir);
  for (const path of paths) {
    const text = readFileSync(join(dir, path), 'utf8');
    let doc;
    if (path.endsWith('.meaning.yaml')) { try { doc = parseYaml(text); } catch { doc = null; } }
    const declared = declaredLicence(path, text, doc);
    if (declared !== null && declared !== expected) problems.push(`${file}: ${column} is ${expected}, but ${path} declares ${declared}`);
    if (declared === null && !fromLicenseFiles.has(expected)) problems.push(`${file}: ${column} is ${expected}, but ${path} declares no licence and the repository's LICENSE files name ${fromLicenseFiles.size ? [...fromLicenseFiles].join(', ') : 'none the check recognises'}`);
  }
  return problems;
}

// Fetches every graph at its commit and checks it. `urlFor` maps a repository
// URL to the URL git fetches (tests point it at local repositories);
// `checker` is the result of loadChecker.
export function graphProblems({ root, registry, checker, urlFor = (url) => url, cacheDir = join(root, '.cache', 'graphs') }) {
  const { meaning } = checker;
  const schemaPath = join(checker.dir, 'meaning.schema.json');
  const problems = [];
  const byAddress = new Map(registry.graphs.map((graph) => [graph.data.address, graph]));
  const checkouts = new Map();
  const checkout = (graph, commit) => {
    const key = `${graph.data.repository}@${commit}`;
    if (!checkouts.has(key)) {
      try { checkouts.set(key, meaning.checkoutGit(urlFor(graph.data.repository), commit, { cacheDir, retries: 2 })); } catch (error) { checkouts.set(key, { error: error.message }); }
    }
    return checkouts.get(key);
  };
  // One index per graph and commit: the checker compares concepts by identity.
  const loaded = new Map();
  const loadGraph = (graph, commit) => {
    const key = `${graph.key}@${commit}`;
    if (!loaded.has(key)) loaded.set(key, readGraph(graph, commit));
    return loaded.get(key);
  };
  const readGraph = (graph, commit) => {
    const at = checkout(graph, commit);
    if (at.error) return { error: at.error };
    const { files, missing } = expandPaths(at.dir, graph.data.meaning_files);
    if (missing.length) return { error: `${missing.join(', ')} not found at ${commit}` };
    const address = graph.data.address.slice('meaning://'.length);
    const docs = files.map((path) => ({ path: join(at.dir, path), doc: parseYaml(readFileSync(join(at.dir, path), 'utf8')) }));
    return { ...meaning.indexConcepts(docs, address), dir: at.dir, relative: files };
  };
  // meaning://{repo}?ref={commit} resolves through the registry: the graph registered at that address.
  const resolve = (repo, ref) => {
    const graph = byAddress.get(`meaning://${repo}`);
    if (!graph) return { error: `meaning://${repo} is not registered in this registry` };
    if (!ref) return { error: `meaning://${repo} needs a ?ref= pin` };
    const index = loadGraph(graph, ref);
    return index.error ? { error: `meaning://${repo}?ref=${ref} cannot be read: ${index.error}` } : index;
  };

  for (const graph of registry.graphs) {
    const { file, data } = graph;
    if (!commitPattern.test(data.commit ?? '') || !addressOf(data.repository)) continue; // reported by recordProblems
    const at = checkout(graph, data.commit);
    if (at.error) { problems.push(`${file}: ${at.error}`); continue; }
    if (data.tag) {
      try {
        const tagged = git(['-C', at.dir, 'ls-remote', urlFor(data.repository), `refs/tags/${data.tag}`, `refs/tags/${data.tag}^{}`]).trim().split('\n').filter(Boolean).map((line) => line.split('\t')[0]);
        if (!tagged.includes(data.commit)) problems.push(`${file}: tag ${data.tag} does not point at commit ${data.commit}`);
      } catch (error) { problems.push(`${file}: tag ${data.tag} cannot be read: ${lastLine(error)}`); }
    }
    const meaningFiles = expandPaths(at.dir, data.meaning_files);
    const modelFiles = expandPaths(at.dir, data.model_files);
    for (const [column, missing] of [['meaning_files', meaningFiles.missing], ['model_files', modelFiles.missing]]) {
      for (const path of missing) problems.push(`${file}: ${column}: ${path} does not exist at commit ${data.commit}`);
    }
    if (meaningFiles.missing.length) continue;
    const local = loadGraph(graph, data.commit);
    if (local.error) { problems.push(`${file}: ${local.error}`); continue; }
    const selfRepo = data.address.slice('meaning://'.length);
    const strip = (text) => text.replaceAll(`${at.dir}/`, '');
    problems.push(...meaning.checkMeaning({ local, resolve, schemaPath, selfRepo }).map((problem) => `${file}: ${strip(problem)}`));
    // Models a meaning file reads must be listed, so that model_licence covers them.
    for (const { path, doc } of local.files) {
      for (const model of Object.values(doc?.models ?? {})) {
        const relative = join(path, '..', model).slice(at.dir.length + 1);
        if (!modelFiles.files.includes(relative)) problems.push(`${file}: ${strip(path)} reads the model ${relative}; list it in model_files`);
      }
    }
    problems.push(...licenceProblems(file, at.dir, meaningFiles.files, data.meaning_licence, 'meaning_licence'));
    if (data.model_licence) problems.push(...licenceProblems(file, at.dir, modelFiles.files, data.model_licence, 'model_licence'));
    // Dependencies: exactly the registered graphs the files reference, at the commits they pin.
    const declared = new Map(registry.dependencies.filter((dep) => dep.data.graph === graph.key).map((dep) => [dep.data.depends_on, dep]));
    const referenced = new Set();
    for (const [address, other] of byAddress) {
      if (other === graph) continue;
      const repo = address.slice('meaning://'.length);
      const pins = [...new Set(local.files.flatMap(({ doc }) => meaning.pinsOf(doc, repo)))];
      if (pins.length === 0) continue;
      referenced.add(other.key);
      const dep = declared.get(other.key);
      if (!dep) problems.push(`${file}: the meaning files reference ${address} (pinned ${pins.join(', ')}); add dependencies/$records/${graph.key}--${other.key}.yaml`);
      else if (!pins.includes(dep.data.commit) || pins.length > 1) problems.push(`${dep.file}: commit is ${dep.data.commit}, but the meaning files of ${graph.key} pin ${address} at ${pins.join(', ')}`);
    }
    for (const [dependsOn, dep] of declared) {
      if (!referenced.has(dependsOn)) problems.push(`${dep.file}: ${graph.key} does not reference ${dependsOn} at commit ${data.commit}; remove the dependency`);
    }
  }
  for (const at of checkouts.values()) at.release?.();
  return problems;
}

// index.json: every graph with its dependencies, sorted by id, and a sha256 of
// the graphs array as written (compact JSON) so a consumer can verify one fetch.
export function buildIndex(registry) {
  const graphs = registry.graphs.map(({ key, data }) => ({
    id: key,
    ...data,
    depends: registry.dependencies.filter((dep) => dep.data.graph === key).map((dep) => ({ id: dep.data.depends_on, commit: dep.data.commit })).sort((a, b) => a.id.localeCompare(b.id)),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const checksum = `sha256:${createHash('sha256').update(JSON.stringify(graphs)).digest('hex')}`;
  return `${JSON.stringify({ format: registryFormat, checksum, graphs }, null, 2)}\n`;
}

export function indexProblems(root, registry) {
  const path = join(root, 'index.json');
  const expected = buildIndex(registry);
  if (!existsSync(path)) return ['index.json is missing; run npm run index and commit it'];
  return readFileSync(path, 'utf8') === expected ? [] : ['index.json differs from the records; run npm run index and commit it'];
}

// Every check: records, index.json, then each graph at its commit.
export async function checkRegistry({ root, urlFor, cacheDir = join(root, '.cache') } = {}) {
  const registry = readRegistry(root);
  const problems = [...registry.problems, ...recordProblems(registry), ...indexProblems(root, registry)];
  let checker;
  try { checker = await loadChecker({ root, graphs: registry.graphs, urlFor, cacheDir: join(cacheDir, 'checker') }); } catch (error) {
    problems.push(`checker: ${error.message}`);
    return { problems, graphs: registry.graphs.length };
  }
  problems.push(...graphProblems({ root, registry, checker, urlFor, cacheDir: join(cacheDir, 'graphs') }));
  return { problems, graphs: registry.graphs.length, checker: checker.commit };
}
