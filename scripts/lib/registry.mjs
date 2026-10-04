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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { devNull, tmpdir, userInfo } from 'node:os';
import { isScalar, parse as parseYaml, parseDocument, visit } from 'yaml';
import { homepageProblem } from './urls.mjs';

export const registryFormat = 'meaning-registry/draft-1';
// The graph whose commit supplies the meaning-file schema and the checker.
export const checkerGraph = 'core';
export const checkerRepository = 'https://github.com/meaninggraph/core';
export const checkerBranch = 'main';

// Same rule as the record contract the planned search index uses: lower case,
// digits and single hyphens, at most 80 characters.
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const commitPattern = /^[0-9a-f]{40}$/;
// The hosts a graph may live on, each with the number of path segments that
// name a repository there. Adding a host is a reviewed change to this list.
export const repositoryHosts = new Map([['github.com', 2]]);
const segmentPattern = /^[A-Za-z0-9_.-]+$/;
const tagPattern = /^(?![-.\/])(?!.*\.\.)[A-Za-z0-9._\/-]+$/;
const spdxPattern = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;
// A path inside the repository: relative, no "..", and `*` matches within one
// path segment only (so `*.meaning.yaml` means the repository root).
const pathPattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.*\/-]+$/;

// git only ever talks https to a remote (GIT_ALLOW_PROTOCOL); tests add file
// for local repositories that stand in for https URLs. Every URL or revision
// that comes from a record is passed after --end-of-options, so a value that
// starts with "-" can never be read as an option; records are also refused
// before they reach git unless their repository is a well-formed https URL.
// The user's and the system's git configuration are not read, so a local
// insteadOf rewrite or hook setting cannot change what is fetched or run.
// No hook in a hooks directory and no file-system monitor runs, whichever a
// repository's own configuration names, and replacement refs are not
// followed, so a repository cannot answer for a commit with other content.
// (git also runs hooks that a repository's configuration defines,
// hook.<name>.command, wherever core.hooksPath points; a cached repository
// with such a key is never used, see `unsound`.)
let allowedProtocols = 'https';
export const setGitProtocols = (protocols) => { allowedProtocols = protocols; };
// Every inherited GIT_* variable is dropped (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_CONFIG_*, ...), so an outer
// repository or hook environment cannot redirect these commands; only the TLS
// trust settings and tracing pass through.
const keptGitVariables = new Set(['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH', 'GIT_TRACE', 'GIT_TRACE_PACKET', 'GIT_CURL_VERBOSE']);
export const gitEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') || keptGitVariables.has(name))),
  GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: allowedProtocols, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1',
});
// core.hooksPath is an empty directory this process makes for itself (and
// removes when it ends), so git finds no hook file whichever one it looks for.
let noHooks;
const hooksPath = () => {
  if (!noHooks) {
    noHooks = mkdtempSync(join(tmpdir(), 'meaninggraph-registry-no-hooks-'));
    process.once('exit', () => rmSync(noHooks, { recursive: true, force: true }));
  }
  if (readdirSync(noHooks).length > 0) throw new Error(`${noHooks} must stay empty: it is where git is told to look for hooks`);
  return noHooks;
};
const hardening = () => ['-c', `core.hooksPath=${hooksPath()}`, '-c', 'core.fsmonitor=false'];
// Every git command this module runs, on a cached repository or not.
export const git = (args, options = {}) => execFileSync('git', [...hardening(), ...args], { stdio: 'pipe', env: gitEnv(), ...options }).toString();
// A `run` for core's checkoutGit: the same environment, and --end-of-options
// before `url` in its fetch.
const runFor = (url) => (command, args) => {
  const at = args.indexOf(url);
  return git(at > 0 && args.slice(0, at).includes('fetch') ? [...args.slice(0, at), '--end-of-options', ...args.slice(at)] : args);
};
const lastLine = (error) => String(error.stderr ?? error.message).trim().split('\n').filter(Boolean).pop() ?? 'failed';

const recordsDir = (root, collection) => join(root, collection, '$records');

// YAML merge keys are switched off, so a plain `<<` is an ordinary key. That
// is not enough: the reader still merges when the key carries an explicit tag
// (`!!merge <<:`) and when the file starts with a `%YAML 1.1` directive, which
// also changes how scalars such as `yes` or `1:30` are read. So a record is
// read as a document, and refused when it has any YAML directive or any key
// whose source text is `<<`, whatever its quoting or tag (readRecord).
const yamlOptions = { merge: false };

// Parses one record file: { data, problems }. Throws when the text is not
// YAML (an error, a duplicate key, an unresolved alias, a second document).
export function readRecord(text, file) {
  const doc = parseDocument(text, yamlOptions);
  if (doc.errors.length > 0) throw doc.errors[0];
  const problems = [];
  if (doc.directives.yaml.explicit) problems.push(`${file}: a %YAML directive is not allowed: it changes how values and merge keys are read`);
  let merges = 0;
  visit(doc, { Pair(_, pair) { if (isScalar(pair.key) && pair.key.source === '<<') merges += 1; } });
  if (merges > 0) problems.push(`${file}: "<<" merge keys are not allowed; write every column out, so that every value is checked`);
  return { data: doc.toJS(), problems };
}

// Names an index entry sets itself, which no collection may declare as a column.
const reservedColumns = ['id', 'depends'];

// The columns a collection declares in its definition, in the order of its
// `columns_order` (which must list exactly the keys of `columns`), or a problem
// when the definition cannot be read.
export function readColumns(root, collection) {
  const file = `${collection}/.collection/definition.yaml`;
  try {
    const definition = parseYaml(readFileSync(join(root, file), 'utf8'), yamlOptions);
    const declared = Object.keys(definition?.columns ?? {});
    if (declared.length === 0) return { columns: [], problems: [`${file}: declares no columns`] };
    const reserved = declared.filter((column) => reservedColumns.includes(column));
    if (reserved.length > 0) return { columns: declared.filter((column) => !reservedColumns.includes(column)), problems: [`${file}: ${reserved.map((column) => JSON.stringify(column)).join(', ')} cannot be a column: an index entry's id is the record's file name and its depends comes from the dependency records`] };
    const order = definition.columns_order ?? declared;
    if (!Array.isArray(order) || order.length !== declared.length || !declared.every((column) => order.includes(column))) {
      return { columns: declared, problems: [`${file}: columns_order must list exactly the declared columns (${declared.join(', ')})`] };
    }
    return { columns: [...order], problems: [] };
  } catch (error) {
    return { columns: [], problems: [`${file}: cannot read the collection definition: ${error.message}`] };
  }
}

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
    let read;
    try { read = readRecord(readFileSync(join(dir, name), 'utf8'), file); } catch (error) { problems.push(`${file}: not YAML: ${error.message}`); continue; }
    problems.push(...read.problems);
    records.push({ key: name.slice(0, -'.yaml'.length), file, data: read.data ?? {} });
  }
  return { records, problems };
}

export function readRegistry(root) {
  const graphs = readCollection(root, 'graphs');
  const dependencies = readCollection(root, 'dependencies');
  const maintainers = readCollection(root, 'maintainers');
  const columns = { graphs: readColumns(root, 'graphs'), dependencies: readColumns(root, 'dependencies'), maintainers: readColumns(root, 'maintainers') };
  return {
    graphs: graphs.records,
    dependencies: dependencies.records,
    maintainers: maintainers.records,
    columns: { graphs: columns.graphs.columns, dependencies: columns.dependencies.columns, maintainers: columns.maintainers.columns },
    problems: [...graphs.problems, ...dependencies.problems, ...maintainers.problems, ...columns.graphs.problems, ...columns.dependencies.problems, ...columns.maintainers.problems],
  };
}

// A record is a mapping of declared columns and nothing else: no key the
// collection does not declare (which would otherwise go unchecked). A `<<` key
// is skipped here because readRecord refuses it, in every spelling.
function keyProblems(file, data, declared) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return [`${file}: a record is a mapping of columns`];
  const problems = [];
  for (const key of Object.keys(data)) {
    if (key === '<<') continue; // refused when the file is read (readRecord), once, in whatever spelling
    if (!declared.includes(key)) problems.push(`${file}: ${JSON.stringify(key)} is not a column of this collection (${declared.join(', ')}); the collection definition declares every column`);
  }
  return problems;
}

// meaning://{host}/{path} for https://{host}/{path}, or null. One spelling per
// repository: an allow-listed host (no www., no IP literal, no port, no user),
// exactly the host's number of path segments, none of them "." or "..", no
// `.git` suffix in any case (https://github.com/org/repo.git is
// https://github.com/org/repo), no trailing slash, query or fragment.
export function addressOf(repository) {
  if (typeof repository !== 'string' || !repository.startsWith('https://')) return null;
  const [host, ...segments] = repository.slice('https://'.length).split('/');
  if (!repositoryHosts.has(host) || segments.length !== repositoryHosts.get(host)) return null;
  if (!segments.every((segment) => segmentPattern.test(segment) && segment !== '.' && segment !== '..')) return null;
  if (/\.git$/i.test(segments.at(-1))) return null;
  return `meaning://${host}/${segments.join('/')}`;
}

// A graph whose repository, address and commit are well formed: the only kind
// whose values are ever handed to git.
export const wellFormed = (graph) => Boolean(graph) && addressOf(graph.data.repository) !== null && addressOf(graph.data.repository) === graph.data.address && commitPattern.test(graph.data.commit ?? '');

// Rules on the records alone (no network): the parts of the format that the
// inGitDB collection definitions cannot express.
export function recordProblems({ graphs, dependencies, maintainers = [], columns }) {
  const problems = [];
  for (const { file, data } of maintainers) problems.push(...keyProblems(file, data, columns.maintainers));
  for (const { file, data } of dependencies) problems.push(...keyProblems(file, data, columns.dependencies));
  const byAddress = new Map();
  const byRepository = new Map();
  const ids = new Set(graphs.map((graph) => graph.key));
  for (const { key, file, data } of graphs) {
    problems.push(...keyProblems(file, data, columns.graphs));
    if (!idPattern.test(key) || key.length > 80) problems.push(`${file}: id "${key}" must be lower-case letters, digits and single hyphens, at most 80 characters`);
    if (!commitPattern.test(data.commit ?? '')) problems.push(`${file}: commit must be a full 40-character lower-case commit id`);
    const address = addressOf(data.repository);
    if (!address) problems.push(`${file}: repository must be an https URL of a repository on ${[...repositoryHosts.keys()].join(', ')}, such as https://github.com/{org}/{repo} (no trailing slash, .git, "." or ".." segments)`);
    else if (data.address !== address) problems.push(`${file}: address must be ${address}, the meaning:// form of the repository (draft-1 registers one graph per repository)`);
    // Hosts and most forges ignore case in org and repository names, so
    // https://github.com/Datatug/ChinookDB is chinookdb again.
    for (const [map, value] of [[byAddress, data.address], [byRepository, data.repository]]) {
      if (typeof value === 'string') map.set(value.toLowerCase(), [...(map.get(value.toLowerCase()) ?? []), { key, file, value }]);
    }
    if (data.homepage !== undefined) {
      const problem = homepageProblem(data.homepage);
      if (problem) problems.push(`${file}: homepage: ${problem}`);
    }
    if (data.tag !== undefined && !(typeof data.tag === 'string' && tagPattern.test(data.tag))) problems.push(`${file}: tag must be a tag name (letters, digits, ".", "_", "/", "-"; not starting with "-", ".", or "/")`);
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
      if (owners.length > 1) problems.push(`${owners.at(-1).file}: ${what} ${owners.at(-1).value} is registered under ${owners.length} ids (${owners.map((owner) => `${owner.key}: ${owner.value}`).join(', ')}, compared ignoring case); a graph is registered once`);
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

// The git cache (the checkouts of the graphs and of the checker, and the
// branch histories) is never inside the registry. A pull request can commit a
// `.cache` directory there, and git would run the hooks and obey the
// configuration of a repository it finds in it. The cache is a directory of
// the user's own: $XDG_CACHE_HOME/meaninggraph-registry, or, when
// XDG_CACHE_HOME is not an absolute path, meaninggraph-registry-<user> in the
// system's temporary directory.
export function defaultCacheDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, 'meaninggraph-registry');
  return join(tmpdir(), `meaninggraph-registry-${process.getuid?.() ?? userInfo().username}`);
}
// Each registry directory has its own part of that cache, as it had its own
// `.cache` before, so two checkouts checked at the same time never rewrite
// each other's checkouts. It is not removed with the registry directory.
export const cacheDirFor = (root, base = defaultCacheDir()) => join(base, createHash('sha256').update(realpathSync.native(root)).digest('hex').slice(0, 16));

// Makes a cache directory (mode 0700) and returns it. Refused, because someone
// else could have put repositories in it: a path that is not a real directory
// (a symbolic link is not followed), one another user owns, one that group or
// others can write to, and one inside the registry `root`.
export function prepareCacheDir(dir, root) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory of its own (a symbolic link is not followed); the git cache is not kept there`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${dir} belongs to another user; the git cache is not kept there (set XDG_CACHE_HOME to a directory of your own)`);
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) throw new Error(`${dir} can be written by other users; the git cache is not kept there (chmod 700 it, or set XDG_CACHE_HOME)`);
  if (root !== undefined) {
    // The native realpath also gives a file system's own spelling of a path that ignores case.
    const within = relative(realpathSync.native(root), realpathSync.native(dir));
    if (within === '' || !(within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))) throw new Error(`${dir} is inside the registry ${root}; the git cache is kept outside it, where a pull request cannot commit files`);
  }
  return dir;
}
// What a cache directory holds: checkouts of the checker and of the graphs, and branch histories.
const cacheParts = ['checker', 'graphs', 'history'];
// The prepared cache directory of the registry `root`, inside the prepared per-user one.
const ownCacheDir = (root) => { prepareCacheDir(defaultCacheDir(), root); return prepareCacheDir(cacheDirFor(root), root); };

// The paths under `.cache` that the repository holding `root` tracks. The
// checker does not run on such a registry: nothing reads `.cache` any more, so
// a tracked one is either left over or an attempt to plant repositories.
export function trackedCache(root) {
  try {
    return git(['-C', root, 'ls-files', '-z', '--', ':(icase).cache']).split('\0').filter(Boolean);
  } catch (error) {
    if (/not a git repository/i.test(String(error.stderr))) return [];
    // git's own advice (safe.directory in the user's configuration) cannot help: that configuration is not read.
    if (/dubious ownership/i.test(String(error.stderr))) throw new Error(`cannot tell whether ${root} tracks a .cache directory: its repository belongs to another user, and the check reads no user git configuration that could allow it; run the check as the owner of the checkout`);
    throw new Error(`cannot tell whether ${root} tracks a .cache directory: ${lastLine(error)}`);
  }
}

// What git itself writes into the configuration of the two kinds of repository
// kept in the cache. `required` keys must be there; the `optional` ones depend
// on the platform and the git version. Each has the values it may take. Any
// other key (hooksPath, fsmonitor, a hook.<name>.command, an insteadOf
// rewrite, a filter, an include, a credential helper, a second remote) means
// the repository is not one this module made, or was changed since.
const oneOf = (...values) => (value) => values.includes(value);
const flag = oneOf('true', 'false');
const platformConfig = {
  'core.filemode': flag, 'core.ignorecase': flag, 'core.precomposeunicode': flag, 'core.symlinks': flag, 'core.logallrefupdates': flag,
  'extensions.refstorage': oneOf('files', 'reftable'), 'extensions.objectformat': oneOf('sha1'),
};
// Files in a git directory that make git read objects or history from
// somewhere else, or change the files it writes. A checkout holds one commit
// (a shallow fetch), so it has a `shallow` file; a branch history never does.
const foreignFiles = ['commondir', 'info/grafts', 'info/attributes', 'objects/info/alternates', 'objects/info/http-alternates'];
const checkoutRules = { required: { 'core.repositoryformatversion': oneOf('0', '1'), 'core.bare': oneOf('false') }, optional: platformConfig, foreign: foreignFiles };
const historyRules = (url) => ({
  required: { 'core.repositoryformatversion': oneOf('1'), 'core.bare': oneOf('true'), 'remote.origin.url': oneOf(url), 'remote.origin.promisor': oneOf('true'), 'remote.origin.partialclonefilter': oneOf('tree:0') },
  optional: { ...platformConfig, 'extensions.partialclone': oneOf('origin') },
  foreign: [...foreignFiles, 'shallow'],
});

// Why the git directory `gitDir` of a cached repository cannot be trusted to
// be what this module left there, or null when it can: it is a real
// directory, with the configuration git wrote for it and nothing more (read
// as a file, before any git command runs in the repository), with no file
// that redirects it, and with every object hashing to its name (git fsck), so
// that a commit id names the content it always named.
export function unsound(gitDir, { required, optional, foreign }) {
  try {
    if (!lstatSync(gitDir).isDirectory()) return 'its git directory is not a directory';
    const file = foreign.find((name) => lstatSync(join(gitDir, name), { throwIfNoEntry: false }));
    if (file) return `it has a ${file} file`;
    const entries = git(['config', '--file', join(gitDir, 'config'), '--no-includes', '--list', '-z']).split('\0').filter(Boolean).map((entry) => {
      const at = entry.indexOf('\n');
      return at < 0 ? [entry, null] : [entry.slice(0, at), entry.slice(at + 1)];
    });
    const allowed = (key) => (Object.hasOwn(required, key) ? required[key] : Object.hasOwn(optional, key) ? optional[key] : () => false);
    const set = entries.find(([key, value]) => !allowed(key)(value));
    if (set) return `its configuration sets ${set[0]}${Object.hasOwn(required, set[0]) || Object.hasOwn(optional, set[0]) ? ' to a value git did not write there' : ''}`;
    const unset = Object.keys(required).find((key) => !entries.some(([name]) => name === key));
    if (unset) return `its configuration has no ${unset}`;
  } catch (error) {
    return `it cannot be read: ${lastLine(error)}`;
  }
  try { git(['--git-dir', gitDir, 'fsck', '--no-dangling', '--no-progress']); } catch (error) { return `git fsck: ${lastLine(error)}`; }
  return null;
}
// The same for a checkout of one commit, as fetchCommit and the checker's checkoutGit keep them.
const checkoutUnsound = (dir) => (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() ? unsound(join(dir, '.git'), checkoutRules) : 'it is not a directory');
export const intactCheckout = (dir) => checkoutUnsound(dir) === null;
// Deletes what a directory holds (but for `except`) one entry at a time, so
// that a failure names the entry that cannot be deleted, not the directory.
const empty = (dir, except) => {
  for (const name of readdirSync(dir)) if (name !== except) rmSync(join(dir, name), { recursive: true, force: true });
};
// git trusts a checkout's index when it decides which files to rewrite: an
// entry marked skip-worktree or assume-unchanged, or one whose recorded size
// and times match an altered file, leaves that file as it is and reports no
// difference. A kept checkout therefore loses its index before it is made its
// commit again, so every file is written from the commit; and it loses its
// files, because git reads attributes (line endings, encodings) from a
// .gitattributes it finds in the work tree while it writes them.
const forgetIndex = (dir) => {
  rmSync(join(dir, '.git', 'index'), { force: true });
  empty(dir, '.git');
};
// Deletes a cached repository that is not used again, and says why (a cache
// that never hits would otherwise go unnoticed) and what becomes of it: it is
// fetched anew, unless it cannot be deleted.
const discard = (dir, why) => {
  const kept = lstatSync(dir, { throwIfNoEntry: false });
  if (!kept) return;
  const note = (then) => console.error(`note: the cached ${dir} is not used again (${why}); ${then}`);
  try {
    if (kept.isDirectory()) empty(dir);
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    note('it cannot be deleted');
    throw error;
  }
  note('it is fetched anew');
};

// Fetches one commit of a repository into cacheDir/<commit>. A cached
// checkout is reused only when it can be trusted (see `unsound`) and after it
// has been made exactly that commit again, from nothing but its git directory
// (see forgetIndex): every file written from the commit with a new index, and
// nothing left that differs. Used only to bootstrap the checker; graphs
// are fetched with the checker's own checkoutGit.
export function fetchCommit(url, commit, cacheDir) {
  if (!commitPattern.test(commit)) throw new Error(`${commit} is not a full commit id`);
  const dir = join(cacheDir, commit);
  const at = (...args) => git(['--git-dir', join(dir, '.git'), '--work-tree', dir, ...args]).trim();
  if (lstatSync(dir, { throwIfNoEntry: false })) {
    let why = checkoutUnsound(dir);
    try {
      if (why === null && at('rev-parse', 'HEAD') !== commit) why = 'it is at another commit';
      if (why === null) {
        forgetIndex(dir);
        at('read-tree', '--reset', '-u', 'HEAD');
        at('checkout-index', '--all', '--force');
        at('clean', '-ffdxq');
        if (at('status', '--porcelain', '--ignored', '--untracked-files=all') === '') return dir;
        why = 'its files differ from the commit';
      }
    } catch (error) { why = lastLine(error); }
    discard(dir, why);
  }
  mkdirSync(cacheDir, { recursive: true });
  const work = mkdtempSync(join(cacheDir, '.fetch-'));
  try {
    git(['init', '-q', work]);
    git(['-C', work, 'fetch', '-q', '--depth', '1', '--end-of-options', url, commit]);
    git(['-C', work, 'checkout', '-q', 'FETCH_HEAD']);
    if (git(['-C', work, 'rev-parse', 'HEAD']).trim() !== commit) throw new Error('did not check out that commit');
    renameSync(work, dir);
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw new Error(`cannot fetch ${commit} from ${url}: ${lastLine(error)}`);
  }
  return dir;
}

// The branch a repository's HEAD names (its default branch), from ls-remote.
export function defaultBranch(url) {
  const head = git(['ls-remote', '--symref', '--end-of-options', url, 'HEAD']);
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head);
  if (!match) throw new Error(`${url} does not name a default branch`);
  return match[1];
}

// GitHub serves the commits of every fork through the parent's URL, so a
// commit that can be fetched from a repository is not necessarily that
// repository's. Only a commit in the history of the branch counts: this keeps
// a bare, commits-only (tree:0) clone of the branch per URL in cacheDir,
// fetches it again once per run (`fetched` remembers), and asks git whether
// the commit is an ancestor of the branch (or the branch itself). A commit the
// clone does not have is not in that history either. A kept clone is fetched
// into only when it can be trusted (see `unsound`) and its remote is `url`, and
// then through that remote: a fetch by URL is not a fetch from the clone's
// promisor, so git would look for the trees the clone never had and fail once
// the branch has moved. A clone that cannot be trusted, or that cannot be
// brought up to date, is deleted and cloned again. `run` runs the git commands
// of this function itself (the tests give one whose fetch ends as they choose).
export function onBranch(url, branch, commit, cacheDir, fetched = new Set(), run = git) {
  if (!commitPattern.test(commit) || !tagPattern.test(branch)) return false;
  const dir = join(cacheDir, createHash('sha256').update(`${url}#${branch}`).digest('hex').slice(0, 32));
  const ref = `refs/heads/${branch}`;
  if (!fetched.has(dir)) {
    try {
      let current = false;
      if (lstatSync(dir, { throwIfNoEntry: false })) {
        let why = unsound(dir, historyRules(url));
        if (why === null) {
          try { run(['-C', dir, 'fetch', '-q', '--force', '--no-tags', '--end-of-options', 'origin', `+${ref}:${ref}`]); current = true; } catch (error) { why = `it cannot be brought up to date: ${String(error.stderr).trim() ? lastLine(error) : `git fetch ${error.status === null ? `was killed by ${error.signal}` : `ended with status ${error.status}`}`}`; }
        }
        if (!current) discard(dir, why);
      }
      if (!current) {
        mkdirSync(cacheDir, { recursive: true });
        run(['clone', '-q', '--bare', '--filter=tree:0', '--single-branch', '--branch', branch, '--end-of-options', url, dir]);
      }
    } catch (error) {
      throw new Error(`cannot read the history of ${branch} in ${url}: ${lastLine(error)}`);
    }
    fetched.add(dir);
  }
  try {
    run(['-C', dir, 'merge-base', '--is-ancestor', '--end-of-options', commit, ref]);
    return true;
  } catch {
    return false;
  }
}

// Loads scripts/lib/meaning.mjs of the `core` record's commit, installing its
// locked dependencies (npm ci --ignore-scripts) into the freshly verified
// checkout once per process. The commit must
// be in the history of meaninggraph/core's main branch: a commit that only a
// fork has would otherwise run its own checker code in CI. Returns
// { meaning, dir, commit }.
export async function loadChecker({ root, graphs, urlFor = (url) => url, cacheDir = join(ownCacheDir(root), 'checker'), historyDir = join(ownCacheDir(root), 'history'), fetched = new Set() }) {
  const core = graphs.find((graph) => graph.key === checkerGraph);
  if (!core) throw new Error(`graphs/$records/${checkerGraph}.yaml is missing; the checker is read from that graph's commit`);
  const { repository, commit } = core.data;
  // The checker is code that CI runs, so it only ever comes from this repository.
  if (repository !== checkerRepository) throw new Error(`the ${checkerGraph} record must name ${checkerRepository}, where the checker lives, not ${repository}`);
  if (!commitPattern.test(commit ?? '')) throw new Error(`the ${checkerGraph} record's commit must be a full commit id`);
  if (!onBranch(urlFor(repository), checkerBranch, commit, historyDir, fetched)) {
    throw new Error(`commit ${commit} of the ${checkerGraph} record is not in the history of ${checkerBranch} of ${checkerRepository} (a commit only a fork or another branch has); the checker is not run from it`);
  }
  const key = `${urlFor(repository)}@${commit}@${cacheDir}`;
  if (!checkers.has(key)) {
    const dir = fetchCommit(urlFor(repository), commit, cacheDir);
    const entry = join(dir, 'scripts', 'lib', 'meaning.mjs');
    if (!existsSync(entry)) throw new Error(`${repository} at ${commit} has no scripts/lib/meaning.mjs, so it cannot check meaning files`);
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], { cwd: dir, stdio: 'pipe' });
    checkers.set(key, { meaning: await import(pathToFileURL(entry).href), dir, commit });
  }
  return checkers.get(key);
}
const checkers = new Map();

const globRegExp = (pattern) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);

// Tracked entries of a checkout as { path, mode }; 120000 is a symbolic link
// and 160000 a submodule, neither of which is a file of this repository.
const trackedEntries = (dir) => git(['-C', dir, 'ls-files', '-s', '-z']).split('\0').filter(Boolean).map((line) => {
  const [meta, path] = line.split('\t');
  return { path, mode: meta.split(' ')[0] };
});
const regularModes = new Set(['100644', '100755']);

// The tracked files of a checkout that each pattern matches:
// { files, missing, links } where `links` are matches that are not regular
// files (symbolic links could point outside the checkout).
export function expandPaths(dir, patterns) {
  const tracked = trackedEntries(dir);
  const files = new Set();
  const links = new Set();
  const missing = [];
  for (const pattern of patterns ?? []) {
    const matched = tracked.filter(({ path }) => (pattern.includes('*') ? globRegExp(pattern).test(path) : path === pattern));
    if (matched.length === 0) missing.push(pattern);
    for (const { path, mode } of matched) (regularModes.has(mode) ? files : links).add(path);
  }
  return { files: [...files].sort(), missing, links: [...links].sort() };
}

// Licence texts the check recognises in a repository's LICENSE files.
const licenceTexts = [
  ['MIT', /^\s*(?:The )?MIT License\b/m],
  ['CC0-1.0', /CC0 1\.0 Universal/],
  ['Apache-2.0', /Apache License\s+Version 2\.0/],
  ['CC-BY-4.0', /Attribution 4\.0 International/],
  ['BSD-3-Clause', /BSD 3-Clause/],
];

// The SPDX ids that the tracked, regular LICENSE* files in the repository root
// identify: { all, main, hasMain } where `main` comes from the unsuffixed file
// (LICENSE, LICENCE or COPYING, optionally .md or .txt), the repository's
// default, and `hasMain` says whether such a file is tracked at all (a link
// or a text the check does not recognise still counts as the default).
export function repositoryLicences(dir) {
  const all = new Set();
  const main = new Set();
  let hasMain = false;
  for (const { path, mode } of trackedEntries(dir)) {
    if (path.includes('/') || !/^(LICEN[CS]E|COPYING)/i.test(path)) continue;
    const unsuffixed = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(path);
    hasMain ||= unsuffixed;
    if (!regularModes.has(mode)) continue;
    const text = readFileSync(join(dir, path), 'utf8');
    for (const [id, pattern] of licenceTexts) {
      if (!pattern.test(text)) continue;
      all.add(id);
      if (unsuffixed) main.add(id);
    }
  }
  return { all, main, hasMain };
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
// declares itself, or, when it declares none, the repository's default
// licence. The default is the licence of the unsuffixed LICENSE file when
// there is one (even if the check does not recognise its text); with no such
// file, the one licence all LICENSE files name. When that is not exactly one
// recognised licence, the file must declare its licence itself.
function licenceProblems(file, dir, paths, expected, column) {
  const problems = [];
  const { all, main, hasMain } = repositoryLicences(dir);
  const fallback = hasMain ? main : all;
  for (const path of paths) {
    const text = readFileSync(join(dir, path), 'utf8');
    let doc;
    if (path.endsWith('.meaning.yaml')) { try { doc = parseYaml(text); } catch { doc = null; } }
    const declared = declaredLicence(path, text, doc);
    if (declared !== null && declared !== expected) problems.push(`${file}: ${column} is ${expected}, but ${path} declares ${declared}`);
    if (declared !== null) continue;
    const licenceFiles = hasMain ? 'LICENSE file names' : 'LICENSE files name';
    if (fallback.size !== 1) problems.push(`${file}: ${path} declares no licence, and the repository's ${licenceFiles} ${fallback.size ? `several (${[...fallback].join(', ')})` : 'no licence the check recognises'}; the file must declare its licence (a Licence: or SPDX-License-Identifier: line at the top)`);
    else if (!fallback.has(expected)) problems.push(`${file}: ${column} is ${expected}, but ${path} declares no licence and the repository's default licence (its LICENSE file) is ${[...fallback][0]}`);
  }
  return problems;
}

// Fetches every graph at its commit and checks it. `urlFor` maps a repository
// URL to the URL git fetches (tests point it at local repositories);
// `checker` is the result of loadChecker.
export function graphProblems({ root, registry, checker, urlFor = (url) => url, cacheDir = join(ownCacheDir(root), 'graphs'), historyDir = join(ownCacheDir(root), 'history'), fetched = new Set(), branches = new Map() }) {
  const { meaning } = checker;
  const schemaPath = join(checker.dir, 'meaning.schema.json');
  const problems = [];
  const byAddress = new Map(registry.graphs.map((graph) => [graph.data.address, graph]));
  const byKey = new Map(registry.graphs.map((graph) => [graph.key, graph]));
  const checkouts = new Map();
  // Only well-formed graphs and full commit ids ever reach git. The checker's
  // checkoutGit reuses cacheDir/<commit> when it is that commit. Before it
  // sees a kept checkout, one that cannot be trusted is deleted, so that it is
  // fetched again, and one that can loses its index and files (see forgetIndex).
  // A kept checkout with an entry that cannot be deleted is an error of the
  // graph like a failed fetch, and the checker never sees it.
  const checkout = (graph, commit) => {
    if (!wellFormed(graph) || !commitPattern.test(commit)) return { error: `${graph.file} is not well formed, so it is not fetched` };
    const key = `${graph.data.repository}@${commit}`;
    if (!checkouts.has(key)) {
      const url = urlFor(graph.data.repository);
      const kept = join(cacheDir, commit);
      try {
        if (lstatSync(kept, { throwIfNoEntry: false })) {
          const why = checkoutUnsound(kept);
          try { if (why === null) forgetIndex(kept); else discard(kept, why); } catch (error) { throw new Error(`the cached checkout cannot be cleared: ${error.message}`); }
        }
        checkouts.set(key, meaning.checkoutGit(url, commit, { cacheDir, retries: 2, run: runFor(url) }));
      } catch (error) { checkouts.set(key, { error: error.message }); }
    }
    return checkouts.get(key);
  };
  // A graph's commit, and every commit another graph pins it at, must be in
  // the history of its repository's default branch (see onBranch).
  const offBranch = (graph, commit) => {
    if (!wellFormed(graph) || !commitPattern.test(commit)) return `${graph.file} is not well formed, so its history is not read`;
    const url = urlFor(graph.data.repository);
    try {
      if (!branches.has(url)) branches.set(url, defaultBranch(url));
      const branch = branches.get(url);
      return onBranch(url, branch, commit, historyDir, fetched) ? null : `commit ${commit} is not in the history of ${branch}, the default branch of ${graph.data.repository} (a commit only a fork or another branch has); register a commit from ${branch}`;
    } catch (error) { return error.message; }
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
    const { files, missing, links } = expandPaths(at.dir, graph.data.meaning_files);
    if (missing.length) return { error: `${missing.join(', ')} not found at ${commit}` };
    if (links.length) return { error: `${links.join(', ')} ${links.length === 1 ? 'is' : 'are'} not a regular file at ${commit} (a symbolic link or submodule); meaning files must be files of the repository` };
    const address = graph.data.address.slice('meaning://'.length);
    const docs = [];
    for (const path of files) {
      try { docs.push({ path: join(at.dir, path), doc: parseYaml(readFileSync(join(at.dir, path), 'utf8')) }); } catch (error) { return { error: `${path} is not YAML: ${error.message.split('\n')[0]}` }; }
    }
    return { ...meaning.indexConcepts(docs, address), dir: at.dir, relative: files };
  };
  // meaning://{repo}?ref={commit} resolves through the registry: the graph registered at that address.
  const resolve = (repo, ref) => {
    const graph = byAddress.get(`meaning://${repo}`);
    if (!graph) return { error: `meaning://${repo} is not registered in this registry` };
    if (!wellFormed(graph)) return { error: `meaning://${repo} is registered by ${graph.file}, which is not well formed (its repository must be the https URL whose meaning:// form is its address), so it is not read` };
    if (!ref) return { error: `meaning://${repo} needs a ?ref= pin` };
    const off = commitPattern.test(ref) ? offBranch(graph, ref) : `?ref=${ref} must be a full commit id`;
    if (off) return { error: `meaning://${repo}?ref=${ref}: ${off}` };
    const index = loadGraph(graph, ref);
    return index.error ? { error: `meaning://${repo}?ref=${ref} cannot be read: ${index.error}` } : index;
  };

  const offChecked = new Set();
  for (const graph of registry.graphs) {
    const { file, data } = graph;
    if (!wellFormed(graph)) continue; // reported by recordProblems; never handed to git
    const at = checkout(graph, data.commit);
    if (at.error) { problems.push(`${file}: ${at.error}`); continue; }
    const off = offBranch(graph, data.commit);
    if (off) { problems.push(`${file}: ${off}`); continue; }
    if (data.tag) {
      if (typeof data.tag === 'string' && tagPattern.test(data.tag)) {
        try {
          // Exact ref names: ls-remote patterns also match tails such as refs/heads/x/refs/tags/<tag>.
          const names = new Set([`refs/tags/${data.tag}`, `refs/tags/${data.tag}^{}`]);
          const tagged = git(['ls-remote', '--end-of-options', urlFor(data.repository), `refs/tags/${data.tag}`]).trim().split('\n').filter(Boolean).map((line) => line.split('\t')).filter(([, name]) => names.has(name)).map(([sha]) => sha);
          if (!tagged.includes(data.commit)) problems.push(`${file}: tag ${data.tag} does not point at commit ${data.commit}`);
        } catch (error) { problems.push(`${file}: tag ${data.tag} cannot be read: ${lastLine(error)}`); }
      }
    }
    const meaningFiles = expandPaths(at.dir, data.meaning_files);
    const modelFiles = expandPaths(at.dir, data.model_files);
    for (const [column, missing] of [['meaning_files', meaningFiles.missing], ['model_files', modelFiles.missing]]) {
      for (const path of missing) problems.push(`${file}: ${column}: ${path} does not exist at commit ${data.commit}`);
    }
    for (const [column, links] of [['meaning_files', meaningFiles.links], ['model_files', modelFiles.links]]) {
      for (const path of links) problems.push(`${file}: ${column}: ${path} is not a regular file at commit ${data.commit} (a symbolic link or submodule); list files of the repository`);
    }
    if (meaningFiles.missing.length || meaningFiles.links.length || modelFiles.links.length) continue;
    const local = loadGraph(graph, data.commit);
    if (local.error) { problems.push(`${file}: ${local.error}`); continue; }
    const strip = (text) => text.replaceAll(`${at.dir}/`, '');
    // Models a meaning file reads must be listed files of the repository, so
    // that model_licence covers them; checked before the checker reads them.
    let modelsListed = true;
    for (const { path, doc } of local.files) {
      for (const model of Object.values(doc?.models ?? {})) {
        const where = `${file}: ${strip(path)}`;
        if (typeof model !== 'string' || model.startsWith('/') || model.split('/').includes('..')) { problems.push(`${where}: models: "${model}" must be a relative path that stays inside the repository (no "..")`); modelsListed = false; continue; }
        const relative = join(path, '..', model).slice(at.dir.length + 1);
        if (!modelFiles.files.includes(relative)) { problems.push(`${where} reads the model ${relative}; list it in model_files`); modelsListed = false; }
      }
    }
    if (modelsListed) {
      const selfRepo = data.address.slice('meaning://'.length);
      problems.push(...meaning.checkMeaning({ local, resolve, schemaPath, selfRepo }).map((problem) => `${file}: ${strip(problem)}`));
    }
    problems.push(...licenceProblems(file, at.dir, meaningFiles.files, data.meaning_licence, 'meaning_licence'));
    if (data.model_licence) problems.push(...licenceProblems(file, at.dir, modelFiles.files, data.model_licence, 'model_licence'));
    // Dependencies: exactly the registered graphs the files reference, at the commits they pin.
    const declared = new Map(registry.dependencies.filter((dep) => dep.data.graph === graph.key).map((dep) => [dep.data.depends_on, dep]));
    const referenced = new Set();
    for (const [address, other] of byAddress) {
      if (other === graph || !wellFormed(other)) continue;
      const repo = address.slice('meaning://'.length);
      const pins = [...new Set(local.files.flatMap(({ doc }) => meaning.pinsOf(doc, repo)))];
      if (pins.length === 0) continue;
      referenced.add(other.key);
      // Every pin, wherever in the files it is written, must be on the dependency's default branch.
      for (const pin of pins) {
        if (!commitPattern.test(pin)) { problems.push(`${file}: the meaning files pin ${address} at "${pin}"; a pin is a full commit id`); continue; }
        const off = offBranch(other, pin);
        if (off) problems.push(`${file}: the meaning files pin ${address} at ${pin}: ${off}`);
        offChecked.add(`${other.key}@${pin}`);
      }
      const dep = declared.get(other.key);
      if (!dep) problems.push(`${file}: the meaning files reference ${address} (pinned ${pins.join(', ')}); add dependencies/$records/${graph.key}--${other.key}.yaml`);
      else if (!pins.includes(dep.data.commit) || pins.length > 1) problems.push(`${dep.file}: commit is ${dep.data.commit}, but the meaning files of ${graph.key} pin ${address} at ${pins.join(', ')}`);
    }
    for (const [dependsOn, dep] of declared) {
      if (!referenced.has(dependsOn)) problems.push(`${dep.file}: ${graph.key} does not reference ${dependsOn} at commit ${data.commit}; remove the dependency`);
    }
  }
  // Every dependency record's commit must be on the dependency's default branch too.
  for (const { file, data } of registry.dependencies) {
    const other = byKey.get(data.depends_on);
    if (!wellFormed(other) || !commitPattern.test(data.commit ?? '') || offChecked.has(`${other.key}@${data.commit}`)) continue;
    const off = offBranch(other, data.commit);
    if (off) problems.push(`${file}: ${off}`);
  }
  for (const at of checkouts.values()) at.release?.();
  return problems;
}

// index.json: every graph with its dependencies, sorted by id, and a sha256 of
// the graphs array as written (compact JSON) so a consumer can verify one fetch.
// An entry is built from the columns the graphs definition declares, in the
// order of its `columns_order`, and never from the record as written: the same
// keys in the same order whatever order the record file has, `id` is always the
// file name, and a key that is not a column is never published (recordProblems
// refuses it). Code-unit order, the same in every locale.
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function buildIndex(registry) {
  const graphs = registry.graphs.map(({ key, data }) => ({
    id: key,
    ...Object.fromEntries(registry.columns.graphs.filter((column) => !reservedColumns.includes(column) && data[column] !== undefined).map((column) => [column, data[column]])),
    depends: registry.dependencies.filter((dep) => dep.data.graph === key).map((dep) => ({ id: dep.data.depends_on, commit: dep.data.commit })).sort(byId),
  })).sort(byId);
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
// `fetched` and `branches` remember, across calls, which branch histories were
// fetched and which default branches were read; by default each call starts afresh.
// Nothing is checked, fetched or read from a cache when the registry tracks a
// `.cache` directory, or when the cache directory cannot be trusted
// (prepareCacheDir): the one problem returned says which.
export async function checkRegistry({ root, urlFor, cacheDir, fetched = new Set(), branches = new Map() } = {}) {
  const registry = readRegistry(root);
  try {
    const tracked = trackedCache(root);
    if (tracked.length > 0) throw new Error(`.cache is tracked (${tracked[0]}${tracked.length > 1 ? ` and ${tracked.length - 1} more` : ''}); the checker keeps its git cache outside the registry and does not run on one that commits a cache: git rm -r --cached .cache`);
    cacheDir = cacheDir === undefined ? ownCacheDir(root) : prepareCacheDir(cacheDir, root);
    for (const part of cacheParts) prepareCacheDir(join(cacheDir, part), root);
  } catch (error) {
    return { problems: [`cache: ${error.message}`], graphs: registry.graphs.length };
  }
  const problems = [...registry.problems, ...recordProblems(registry), ...indexProblems(root, registry)];
  let checker;
  const historyDir = join(cacheDir, 'history');
  try { checker = await loadChecker({ root, graphs: registry.graphs, urlFor, cacheDir: join(cacheDir, 'checker'), historyDir, fetched }); } catch (error) {
    problems.push(`checker: ${error.message}`);
    return { problems, graphs: registry.graphs.length };
  }
  problems.push(...graphProblems({ root, registry, checker, urlFor, cacheDir: join(cacheDir, 'graphs'), historyDir, fetched, branches }));
  return { problems, graphs: registry.graphs.length, checker: checker.commit };
}
