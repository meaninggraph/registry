// Tests for the registry checks (CC0-1.0). Each test copies the registry into a
// temporary directory, breaks one thing, and expects the check to name it.
// The checker and the registered graphs are fetched from GitHub at their
// commits (cached outside the repository, in this checkout's part of the
// user's cache directory); a graph whose files must be broken is a local git
// repository that stands in for an https URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseHcl, serializeModel, toModelspecJson } from './lib/modelspec.mjs';
import { buildIndex, cacheDirFor, checkRegistry, checkerRepository, declaredLicence, defaultBranch, defaultCacheDir, fetchCommit, git, gitEnv, intactCheckout, loadChecker, onBranch, readRegistry, recordProblems, repositoryHosts, setGitProtocols } from './lib/registry.mjs';
import { homepageProblem, maxHomepageLength, publicHttpsProblem } from './lib/urls.mjs';

// The local repositories that stand in for https URLs are file:// URLs, at
// https://example.test/fixtures/<name>; the tests allow that host.
setGitProtocols('https:file');
repositoryHosts.set('example.test', 2);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = cacheDirFor(root);
const scratch = mkdtempSync(join(tmpdir(), 'registry-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

const record = (dir, collection, key) => join(dir, collection, '$records', `${key}.yaml`);
const readRecord = (dir, collection, key) => parseYaml(readFileSync(record(dir, collection, key), 'utf8'));
const writeRecord = (dir, collection, key, data) => writeFileSync(record(dir, collection, key), stringifyYaml(data));
const writeIndex = (dir) => writeFileSync(join(dir, 'index.json'), buildIndex(readRegistry(dir)));

// A copy of this registry; `change(dir)` breaks it, then index.json is rebuilt
// unless the test is about index.json.
function registry(change, { rebuildIndex = true } = {}) {
  const dir = join(scratch, `registry-${count++}`);
  mkdirSync(dir);
  for (const name of ['.ingitdb', 'graphs', 'dependencies', 'maintainers', 'index.json']) cpSync(join(root, name), join(dir, name), { recursive: true });
  change?.(dir);
  if (rebuildIndex) writeIndex(dir);
  return dir;
}

// A local git repository with `files` (and, with `from`, a copy of that
// directory without .git and node_modules) on main, standing in for
// `repository` (default https://example.test/fixtures/<name>). With `side`,
// those files are committed on a branch that main does not contain: the
// stand-in for a commit that only a fork has, which GitHub still serves
// through the parent's URL.
const origins = new Map();
function origin(name, files, { from, side, symlinks = {}, branches = [], tags = [], repository = `https://example.test/fixtures/${name}` } = {}) {
  const dir = join(scratch, `origin-${count++}`);
  mkdirSync(dir);
  // Every git call of this suite runs in gitEnv(): no GIT_ variable, and neither the user's nor the
  // system's git configuration (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1), so a fixture
  // commit never meets commit.gpgsign, a hook or an alias of whoever runs the tests.
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: gitEnv() }).toString().trim();
  const commitFiles = (entries, links = {}) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    for (const [path, target] of Object.entries(links)) symlinkSync(target, join(dir, path));
    git('add', '.');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'files');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  if (from) cpSync(from, dir, { recursive: true, filter: (path) => !/\/(\.git|node_modules)(\/|$)/.test(path.slice(from.length)) });
  const commit = commitFiles(files, symlinks);
  for (const branch of branches) git('branch', branch);
  for (const tag of tags) git('tag', tag);
  let sideCommit;
  if (side) {
    git('checkout', '-q', '-b', 'side');
    sideCommit = commitFiles(side);
    git('checkout', '-q', 'main');
  }
  origins.set(repository, `file://${dir}`);
  return { repository, address: `meaning://${repository.slice('https://'.length)}`, commit, sideCommit };
}
const urlFor = (url) => origins.get(url) ?? url;
// Branch histories are fetched once for the whole run, not once per test.
const seen = { fetched: new Set(), branches: new Map() };
const check = (dir) => checkRegistry({ root: dir, urlFor, cacheDir, ...seen });

const meaningFile = (extra = {}) => stringifyYaml({
  format: 'meaning/draft-1',
  id: 'fixture',
  name: 'Fixture',
  description: 'A graph for the tests.',
  license: 'CC0-1.0',
  concepts: [{ id: 'thing', kind: 'entity', labels: { en: 'Thing' }, description: 'A thing.' }],
  ...extra,
});
const fixtureRecord = (source, extra = {}) => ({
  format: 'meaning-registry/draft-1',
  title: 'Fixture',
  description: 'A graph for the tests.',
  kind: 'dataset',
  status: 'draft',
  address: source.address,
  repository: source.repository,
  commit: source.commit,
  meaning_files: ['fixture.meaning.yaml'],
  meaning_licence: 'CC0-1.0',
  maintainers: ['trakhimenok'],
  ...extra,
});
const fixtureModelHcl = '# SPDX-License-Identifier: BSD-3-Clause\nentity "Fixture" {\n  key = ["id"]\n  property "id" {\n    type = "string"\n  }\n}\n';
const fixtureModelJson = (hcl = fixtureModelHcl) => serializeModel(toModelspecJson(parseHcl(hcl), { id: 'fixture', name: 'Fixture', version: '1.0.0' }));
const fixtureModelFiles = (hcl = fixtureModelHcl, json = fixtureModelJson(hcl)) => ({
  'fixture.meaning.yaml': meaningFile(),
  'model/fixture.modelspec.hcl': hcl,
  'model/fixture.modelspec.json': json,
  LICENSE: 'The MIT License (MIT)\n',
});
// What recordProblems needs besides the graphs: the columns the committed collection definitions declare.
const context = { maintainers: readRegistry(root).maintainers, columns: readRegistry(root).columns };
const expectProblem = (problems, pattern) => assert.ok(problems.some((problem) => pattern.test(problem)), `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`);

test('the registry as committed passes every check', async () => {
  const { problems, graphs } = await check(root);
  assert.deepEqual(problems, []);
  assert.equal(graphs, 10);
  const pubs = readRecord(root, 'graphs', 'pubs');
  assert.equal(pubs.commit, '6c06c5c7395b03ff1a02c2b1a21485add3e1b65b');
  const sakila = readRecord(root, 'graphs', 'sakila');
  assert.deepEqual(
    [sakila.address, sakila.repository, sakila.commit, sakila.meaning_licence, sakila.model_licence],
    ['meaning://github.com/demo-db/sakila', 'https://github.com/demo-db/sakila', 'cb9a81a8cbedcd8831737f281f888d5d584fae85', 'CC0-1.0', 'BSD-3-Clause'],
  );
  assert.deepEqual(readRecord(root, 'dependencies', 'sakila--core'), {
    graph: 'sakila', depends_on: 'core', commit: '982916d73f0a35ff2558b0062f58aa3ac4f24d97',
  });
});

test('an unknown commit fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), commit: '0c34c1a3e0616fa53810916503b3bf3c8a925800' }));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: cannot fetch 0c34c1a3e0616fa53810916503b3bf3c8a925800 from https:\/\/github\.com\/demo-db\/chinook: .*not our ref/);
});

test('a path that does not exist at the commit fails', async () => {
  const dir = registry((d) => {
    const chinook = readRecord(d, 'graphs', 'chinook');
    writeRecord(d, 'graphs', 'chinook', { ...chinook, model_files: [...chinook.model_files, 'model/missing.modelspec.hcl'] });
  });
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: model_files: model\/missing\.modelspec\.hcl does not exist at commit 26e852c/);
});

test('a meaning file that does not fit the meaning/draft-1 schema fails', async () => {
  const source = origin('broken', { 'fixture.meaning.yaml': meaningFile({ name: undefined, colour: 'blue' }), LICENSE: 'CC0 1.0 Universal\n' });
  const dir = registry((d) => writeRecord(d, 'graphs', 'broken', fixtureRecord(source)));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/broken\.yaml: fixture\.meaning\.yaml: schema: \/ must have required property 'name'/);
  expectProblem(problems, /^graphs\/\$records\/broken\.yaml: fixture\.meaning\.yaml: schema: \/ must NOT have additional properties \(colour\)/);
});

test('a well-formed fixture graph passes, so the failures above are about what each test broke', async () => {
  const source = origin('fine', { 'fixture.meaning.yaml': meaningFile(), LICENSE: 'CC0 1.0 Universal\n' });
  const dir = registry((d) => writeRecord(d, 'graphs', 'fine', fixtureRecord(source)));
  assert.deepEqual((await check(dir)).problems, []);
});

test('a licence that differs from the one the files declare fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), meaning_licence: 'MIT', model_licence: 'Apache-2.0' }));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: meaning_licence is MIT, but model\/chinook\.meaning\.yaml declares CC0-1.0/);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: model_licence is Apache-2\.0, but model\/chinook\.modelspec\.hcl declares MIT/);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: model_licence is Apache-2\.0, but model\/chinook\.modelspec\.json declares MIT/);
});

test('the same graph registered under a second id fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook-again', readRecord(d, 'graphs', 'chinook')));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: address meaning:\/\/github\.com\/demo-db\/chinook is registered under 2 ids \(chinook-again: meaning:\/\/github\.com\/demo-db\/chinook, chinook: meaning:\/\/github\.com\/demo-db\/chinook, compared ignoring case\); a graph is registered once$/);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: repository https:\/\/github\.com\/demo-db\/chinook is registered under 2 ids/);
});

test('an id that the record contract would reject fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'Core_2', { ...readRecord(d, 'graphs', 'core'), address: 'meaning://github.com/meaninggraph/other', repository: 'https://github.com/meaninggraph/other' }));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/Core_2\.yaml: id "Core_2" must be lower-case letters, digits and single hyphens/);
});

test('an address that is not the meaning:// form of the repository fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), address: 'meaning://github.com/datatug/chinook' }));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: address must be meaning:\/\/github\.com\/demo-db\/chinook/);
});

test('a dependency pinned at another commit than the files pin fails', async () => {
  const dir = registry((d) => writeRecord(d, 'dependencies', 'chinook--core', { ...readRecord(d, 'dependencies', 'chinook--core'), commit: '4214bc73cbfcc706c0ea9c8873eba991d9ddbb91' }));
  expectProblem((await check(dir)).problems, /^dependencies\/\$records\/chinook--core\.yaml: commit is 4214bc73cbfcc706c0ea9c8873eba991d9ddbb91, but the meaning files of chinook pin meaning:\/\/github\.com\/meaninggraph\/core at 982916d73f0a35ff2558b0062f58aa3ac4f24d97/);
});

test('a dependency that the files do not declare fails, and so does one they do not use', async () => {
  const missing = registry((d) => rmSync(record(d, 'dependencies', 'chinook--core')));
  expectProblem((await check(missing)).problems, /^graphs\/\$records\/chinook\.yaml: the meaning files reference meaning:\/\/github\.com\/meaninggraph\/core \(pinned 982916d[0-9a-f]+\); add dependencies\/\$records\/chinook--core\.yaml/);
  const unused = registry((d) => writeRecord(d, 'dependencies', 'core--chinook', { graph: 'core', depends_on: 'chinook', commit: '6f1bac962bccadeaa3f85e19454486ad79544ad4' }));
  expectProblem((await check(unused)).problems, /^dependencies\/\$records\/core--chinook\.yaml: core does not reference chinook at commit 982916d[0-9a-f]+; remove the dependency/);
});

test('a reference to a graph that is not registered fails', async () => {
  const source = origin('orphan', {
    'fixture.meaning.yaml': meaningFile({ concepts: [{ id: 'thing', kind: 'entity', labels: { en: 'Thing' }, description: 'A thing.', extends: `meaning://example.test/fixtures/nowhere/thing?ref=${'a'.repeat(40)}` }] }),
    LICENSE: 'CC0 1.0 Universal\n',
  });
  const dir = registry((d) => writeRecord(d, 'graphs', 'orphan', fixtureRecord(source)));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/orphan\.yaml: fixture\.meaning\.yaml: concept thing extends: meaning:\/\/example\.test\/fixtures\/nowhere is not registered in this registry/);
});

test('a model that a meaning file reads must be listed in model_files', async () => {
  const dir = registry((d) => {
    const chinook = readRecord(d, 'graphs', 'chinook');
    writeRecord(d, 'graphs', 'chinook', { ...chinook, model_files: ['model/chinook.modelspec.json'] });
  });
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: model\/chinook\.meaning\.yaml reads the model model\/chinook\.modelspec\.hcl; list it in model_files/);
});

test('the checker is only ever taken from meaninggraph/core', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'core', { ...readRecord(d, 'graphs', 'core'), repository: 'https://github.com/someone/core', address: 'meaning://github.com/someone/core' }));
  expectProblem((await check(dir)).problems, /^checker: the core record must name https:\/\/github\.com\/meaninggraph\/core, where the checker lives/);
});

test('a graph commit must be in the history of the default branch', async () => {
  const source = origin('forked', { 'fixture.meaning.yaml': meaningFile(), LICENSE: 'CC0 1.0 Universal\n' }, { side: { 'fixture.meaning.yaml': meaningFile({ description: 'Changed on a branch main does not contain.' }) } });
  const onMain = registry((d) => writeRecord(d, 'graphs', 'forked', fixtureRecord(source)));
  assert.deepEqual((await check(onMain)).problems, [], 'the commit on main passes');
  const offMain = registry((d) => writeRecord(d, 'graphs', 'forked', fixtureRecord(source, { commit: source.sideCommit })));
  expectProblem((await check(offMain)).problems, new RegExp(`^graphs/\\$records/forked\\.yaml: commit ${source.sideCommit} is not in the history of main, the default branch of https://example\\.test/fixtures/forked \\(a commit only a fork or another branch has\\)`));
});

test('the checker runs only from a commit in the history of meaninggraph/core main', async () => {
  // A local stand-in for meaninggraph/core: the registered core commit's files on
  // main, and an altered checker on a side branch.
  const core = readRecord(root, 'graphs', 'core');
  const coreFiles = fetchCommit(core.repository, core.commit, join(cacheDir, 'checker'));
  const local = origin('core', {}, { from: coreFiles, repository: checkerRepository, side: { 'scripts/lib/meaning.mjs': 'throw new Error("altered checker code ran");\n' } });
  const fakeOrigins = (url) => (url === checkerRepository ? origins.get(url) : url);
  const graphs = (commit) => [{ key: 'core', data: { ...core, commit } }];
  const options = { root: scratch, urlFor: fakeOrigins, cacheDir: join(scratch, 'checker-cache'), historyDir: join(scratch, 'history-cache') };
  const checker = await loadChecker({ ...options, graphs: graphs(local.commit) });
  assert.equal(typeof checker.meaning.checkMeaning, 'function', 'the commit on main loads');
  await assert.rejects(loadChecker({ ...options, graphs: graphs(local.sideCommit) }), new RegExp(`commit ${local.sideCommit} of the core record is not in the history of main of https://github\\.com/meaninggraph/core`));
  origins.delete(checkerRepository);
});

const CC0 = 'CC0 1.0 Universal\n';

// B1: a record value must never reach git as an option. The payload only
// creates a marker file; the test fails if it ever appears.
test('a repository value written as a git option is refused and never runs', async () => {
  const marker = join(scratch, `MARKER-${count++}`);
  const ref = 'a'.repeat(40);
  const evilAddress = 'meaning://example.test/fixtures/evil';
  const a = origin('argv', { 'fixture.meaning.yaml': meaningFile({ concepts: [{ id: 'thing', kind: 'entity', labels: { en: 'Thing' }, description: 'x', extends: `${evilAddress}/thing?ref=${ref}` }] }), LICENSE: CC0 });
  const dir = registry((d) => {
    writeRecord(d, 'graphs', 'argv', fixtureRecord(a));
    writeRecord(d, 'graphs', 'evil', fixtureRecord({ address: evilAddress, repository: `--upload-pack=touch ${marker};false`, commit: ref }));
  });
  const { problems } = await check(dir);
  assert.equal(existsSync(marker), false, 'a record value ran a command');
  expectProblem(problems, /^graphs\/\$records\/evil\.yaml: repository must be an https URL of a repository/);
  expectProblem(problems, /^graphs\/\$records\/argv\.yaml: fixture\.meaning\.yaml: concept thing extends: meaning:\/\/example\.test\/fixtures\/evil is registered by graphs\/\$records\/evil\.yaml, which is not well formed/);
});

test('git reads a URL after --end-of-options and talks only the allowed protocols', () => {
  const marker = join(scratch, `MARKER-${count++}`);
  assert.throws(() => defaultBranch(`--upload-pack=touch ${marker};false`));
  assert.equal(existsSync(marker), false, 'an option-shaped URL ran a command');
  const local = origin('protocols', { README: 'x\n' });
  assert.equal(defaultBranch(origins.get(local.repository)), 'main');
  setGitProtocols('https');
  try {
    assert.throws(() => defaultBranch(origins.get(local.repository)), /transport 'file' not allowed/);
  } finally { setGitProtocols('https:file'); }
});

// S1: every pin, in any field, and every dependency record's commit must be on the default branch.
test('a dependency pinned at a commit off its default branch fails, in any field and in the dependency record', async () => {
  const b = origin('pinned', { 'fixture.meaning.yaml': meaningFile(), LICENSE: CC0 }, { side: { 'fixture.meaning.yaml': meaningFile({ description: 'side' }) } });
  const inDescription = `meaning://example.test/fixtures/pinned/thing?ref=${b.sideCommit}`;
  const a = origin('pinning', { 'fixture.meaning.yaml': meaningFile({ concepts: [{ id: 'thing', kind: 'entity', labels: { en: 'Thing' }, description: inDescription }] }), LICENSE: CC0 });
  const dir = registry((d) => {
    writeRecord(d, 'graphs', 'pinned', fixtureRecord(b));
    writeRecord(d, 'graphs', 'pinning', fixtureRecord(a));
    writeRecord(d, 'dependencies', 'pinning--pinned', { graph: 'pinning', depends_on: 'pinned', commit: b.sideCommit });
  });
  expectProblem((await check(dir)).problems, new RegExp(`^graphs/\\$records/pinning\\.yaml: the meaning files pin meaning://example\\.test/fixtures/pinned at ${b.sideCommit}: commit ${b.sideCommit} is not in the history of main`));
  const record = registry((d) => {
    writeRecord(d, 'graphs', 'pinned', fixtureRecord(b));
    writeRecord(d, 'graphs', 'pinning-main', fixtureRecord(origin('pinning-main', { 'fixture.meaning.yaml': meaningFile({ concepts: [{ id: 'thing', kind: 'entity', labels: { en: 'Thing' }, description: 'x', extends: `meaning://example.test/fixtures/pinned/thing?ref=${b.commit}` }] }), LICENSE: CC0 })));
    writeRecord(d, 'dependencies', 'pinning-main--pinned', { graph: 'pinning-main', depends_on: 'pinned', commit: b.sideCommit });
  });
  expectProblem((await check(record)).problems, new RegExp(`^dependencies/\\$records/pinning-main--pinned\\.yaml: commit ${b.sideCommit} is not in the history of main`));
});

// S2: one repository, two spellings.
test('the same repository spelled with .git or in another case is refused', async () => {
  const dotGit = registry((d) => {
    writeRecord(d, 'graphs', 'chinook-dup', { ...readRecord(d, 'graphs', 'chinook'), repository: 'https://github.com/demo-db/chinook.git', address: 'meaning://github.com/demo-db/chinook.git' });
    writeRecord(d, 'dependencies', 'chinook-dup--core', { ...readRecord(d, 'dependencies', 'chinook--core'), graph: 'chinook-dup' });
  });
  expectProblem((await check(dotGit)).problems, /^graphs\/\$records\/chinook-dup\.yaml: repository must be an https URL of a repository on github\.com, example\.test, such as https:\/\/github\.com\/\{org\}\/\{repo\} \(no trailing slash, \.git, "\." or "\.\." segments\)/);
  const cased = registry((d) => {
    writeRecord(d, 'graphs', 'chinook-dup', { ...readRecord(d, 'graphs', 'chinook'), repository: 'https://github.com/Demo-DB/Chinook', address: 'meaning://github.com/Demo-DB/Chinook' });
    writeRecord(d, 'dependencies', 'chinook-dup--core', { ...readRecord(d, 'dependencies', 'chinook--core'), graph: 'chinook-dup' });
  });
  const { problems } = await check(cased);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: repository https:\/\/github\.com\/demo-db\/chinook is registered under 2 ids \(chinook-dup: https:\/\/github\.com\/Demo-DB\/Chinook, chinook: https:\/\/github\.com\/demo-db\/chinook, compared ignoring case\)/);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: address meaning:\/\/github\.com\/demo-db\/chinook is registered under 2 ids/);
});

test('a model path that leaves the repository is refused before the checker reads it', async () => {
  const outside = join(scratch, `outside-${count++}.hcl`);
  writeFileSync(outside, 'SECRET = "do-not-read"\n');
  const source = origin('traversal', { 'fixture.meaning.yaml': meaningFile({ models: { m: `${'../'.repeat(30)}${outside.slice(1)}` } }), LICENSE: CC0 });
  const dir = registry((d) => writeRecord(d, 'graphs', 'traversal', fixtureRecord(source)));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/traversal\.yaml: fixture\.meaning\.yaml: models: ".*" must be a relative path that stays inside the repository/);
  assert.ok(!problems.some((problem) => problem.includes('do-not-read')));
});

test('a listed file that is a symbolic link is refused', async () => {
  const outside = join(scratch, `outside-${count++}.meaning.yaml`);
  writeFileSync(outside, 'format: meaning/draft-1\nid: x\nname: LEAKED\n');
  const source = origin('symlink', { LICENSE: CC0 }, { symlinks: { 'fixture.meaning.yaml': outside } });
  const dir = registry((d) => writeRecord(d, 'graphs', 'symlink', fixtureRecord(source)));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/symlink\.yaml: meaning_files: fixture\.meaning\.yaml is not a regular file at commit [0-9a-f]{40} \(a symbolic link or submodule\)/);
  assert.ok(!problems.some((problem) => problem.includes('LEAKED')));
});

test('a file without a licence takes the repository default, and must declare one when there is none', async () => {
  const withDefault = origin('licence-default', { 'fixture.meaning.yaml': meaningFile(), 'm.modelspec.json': '{}', LICENSE: 'The MIT License (MIT)\n', 'LICENSE-CC0': CC0 });
  const wrong = registry((d) => writeRecord(d, 'graphs', 'licence-default', fixtureRecord(withDefault, { model_files: ['m.modelspec.json'], model_licence: 'CC0-1.0' })));
  expectProblem((await check(wrong)).problems, /^graphs\/\$records\/licence-default\.yaml: model_licence is CC0-1\.0, but m\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);
  const right = registry((d) => writeRecord(d, 'graphs', 'licence-default', fixtureRecord(withDefault, { model_files: ['m.modelspec.json'], model_licence: 'MIT' })));
  assert.deepEqual((await check(right)).problems, []);
  const noDefault = origin('licence-several', { 'fixture.meaning.yaml': meaningFile(), 'm.modelspec.json': '{}', 'LICENSE-MIT': 'MIT License\n', 'LICENSE-CC0': CC0 });
  const ambiguous = registry((d) => writeRecord(d, 'graphs', 'licence-several', fixtureRecord(noDefault, { model_files: ['m.modelspec.json'], model_licence: 'MIT' })));
  expectProblem((await check(ambiguous)).problems, /^graphs\/\$records\/licence-several\.yaml: m\.modelspec\.json declares no licence, and the repository's LICENSE files name several \((MIT, CC0-1\.0|CC0-1\.0, MIT)\); the file must declare its licence/);
});

test('a ModelSpec JSON twin inherits its explicit HCL licence', async () => {
  const hcl = fixtureModelHcl;
  const source = origin('modelspec-license-twin', fixtureModelFiles());
  const modelFiles = ['model/fixture.modelspec.hcl', 'model/fixture.modelspec.json'];
  const valid = registry((d) => writeRecord(d, 'graphs', 'modelspec-license-twin', fixtureRecord(source, { model_files: modelFiles, model_licence: 'BSD-3-Clause' })));
  assert.deepEqual((await check(valid)).problems, []);
  const wrong = registry((d) => writeRecord(d, 'graphs', 'modelspec-license-twin', fixtureRecord(source, { model_files: modelFiles, model_licence: 'MIT' })));
  const problems = (await check(wrong)).problems;
  expectProblem(problems, /^graphs\/\$records\/modelspec-license-twin\.yaml: model_licence is MIT, but model\/fixture\.modelspec\.hcl declares BSD-3-Clause/);
  expectProblem(problems, /^graphs\/\$records\/modelspec-license-twin\.yaml: model_licence is MIT, but model\/fixture\.modelspec\.json declares BSD-3-Clause/);
});

test('a paired ModelSpec JSON AST must be valid, duplicate-free, and match its HCL source', async () => {
  const modelFiles = ['model/fixture.modelspec.hcl', 'model/fixture.modelspec.json'];
  const baseRecord = (source) => fixtureRecord(source, { model_files: modelFiles, model_licence: 'BSD-3-Clause' });

  const divergentAst = toModelspecJson(parseHcl(fixtureModelHcl), { id: 'fixture', name: 'Fixture', version: '1.0.0' });
  divergentAst.entities.Fixture.properties.id.type = 'int';
  const divergent = origin('modelspec-divergent-twin', fixtureModelFiles(fixtureModelHcl, serializeModel(divergentAst)));
  const mismatch = registry((d) => writeRecord(d, 'graphs', 'modelspec-divergent-twin', baseRecord(divergent)));
  expectProblem((await check(mismatch)).problems, /^graphs\/\$records\/modelspec-divergent-twin\.yaml: model\/fixture\.modelspec\.json does not match model\/fixture\.modelspec\.hcl: entities\.Fixture\.properties\.id\.type is "string" in the HCL source but "int" in the JSON AST$/);

  const duplicate = origin('modelspec-duplicate-json', fixtureModelFiles(fixtureModelHcl, '{"modelspec":"1.0-draft","module":{},"module":{}}\n'));
  const duplicateDir = registry((d) => writeRecord(d, 'graphs', 'modelspec-duplicate-json', baseRecord(duplicate)));
  expectProblem((await check(duplicateDir)).problems, /^graphs\/\$records\/modelspec-duplicate-json\.yaml: model\/fixture\.modelspec\.json is not valid ModelSpec JSON: duplicate name "module"/);

  const malformed = origin('modelspec-malformed-json', fixtureModelFiles(fixtureModelHcl, '{ invalid json\n'));
  const malformedDir = registry((d) => writeRecord(d, 'graphs', 'modelspec-malformed-json', baseRecord(malformed)));
  expectProblem((await check(malformedDir)).problems, /^graphs\/\$records\/modelspec-malformed-json\.yaml: model\/fixture\.modelspec\.json is not valid ModelSpec JSON: expected a name/);

  const invalidAst = serializeModel({ ...toModelspecJson(parseHcl(fixtureModelHcl), { id: 'fixture', name: 'Fixture', version: '1.0.0' }), module: {} });
  const invalid = origin('modelspec-invalid-json', fixtureModelFiles(fixtureModelHcl, invalidAst));
  const invalidDir = registry((d) => writeRecord(d, 'graphs', 'modelspec-invalid-json', baseRecord(invalid)));
  expectProblem((await check(invalidDir)).problems, /^graphs\/\$records\/modelspec-invalid-json\.yaml: model\/fixture\.modelspec\.json is not a valid ModelSpec JSON AST: module\.id and module\.version are required$/);

  const unsupportedHcl = `${fixtureModelHcl}\ncollection "FixtureRows" {}\n`;
  const unsupported = origin('modelspec-unsupported-hcl', fixtureModelFiles(unsupportedHcl, fixtureModelJson()));
  const unsupportedDir = registry((d) => writeRecord(d, 'graphs', 'modelspec-unsupported-hcl', baseRecord(unsupported)));
  expectProblem((await check(unsupportedDir)).problems, /^graphs\/\$records\/modelspec-unsupported-hcl\.yaml: model\/fixture\.modelspec\.hcl cannot be converted to ModelSpec JSON: line \d+: top-level collection blocks are not supported by this converter/);
});

test('CC-BY-SA-3.0 SPDX identifiers are recognized as repository defaults', async () => {
  const source = origin('cc-by-sa-default', {
    'fixture.meaning.yaml': meaningFile(),
    'm.modelspec.json': '{}\n',
    LICENSE: 'SPDX-License-Identifier: CC-BY-SA-3.0\n',
  });
  const dir = registry((d) => writeRecord(d, 'graphs', 'cc-by-sa-default', fixtureRecord(source, { model_files: ['m.modelspec.json'], model_licence: 'CC-BY-SA-3.0' })));
  assert.deepEqual((await check(dir)).problems, []);
});

test('a tag must be that exact tag, not a branch whose name ends like it', async () => {
  const lookalike = origin('tag-lookalike', { 'fixture.meaning.yaml': meaningFile(), LICENSE: CC0 }, { branches: ['x/refs/tags/v1'] });
  const dir = registry((d) => writeRecord(d, 'graphs', 'tag-lookalike', fixtureRecord(lookalike, { tag: 'v1' })));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/tag-lookalike\.yaml: tag v1 does not point at commit/);
  const tagged = origin('tag-real', { 'fixture.meaning.yaml': meaningFile(), LICENSE: CC0 }, { tags: ['v1'] });
  const real = registry((d) => writeRecord(d, 'graphs', 'tag-real', fixtureRecord(tagged, { tag: 'v1' })));
  assert.deepEqual((await check(real)).problems, []);
  const optionLike = registry((d) => writeRecord(d, 'graphs', 'tag-real', fixtureRecord(tagged, { tag: '--upload-pack=x' })));
  expectProblem((await check(optionLike)).problems, /^graphs\/\$records\/tag-real\.yaml: tag must be a tag name/);
});

test('a missing meaning file, a stray record file and bad paths fail', async () => {
  const missing = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), meaning_files: ['model/missing.meaning.yaml'] }));
  expectProblem((await check(missing)).problems, /^graphs\/\$records\/chinook\.yaml: meaning_files: model\/missing\.meaning\.yaml does not exist at commit 26e852c/);
  const stray = registry((d) => writeFileSync(join(d, 'graphs', '$records', 'stray.yml'), 'x: 1\n'));
  expectProblem((await check(stray)).problems, /^graphs\/\$records\/stray\.yml: a record is a <key>\.yaml file/);
  const paths = registry((d) => writeRecord(d, 'graphs', 'core', { ...readRecord(d, 'graphs', 'core'), meaning_files: ['../x.meaning.yaml', 'README.md'], model_files: ['a.hcl'], model_licence: 'MIT' }));
  const { problems } = await check(paths);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: meaning_files: "\.\.\/x\.meaning\.yaml" must be a relative path inside the repository/);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: meaning_files: "README\.md" must name \*\.meaning\.yaml files/);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: a universal graph has no model files/);
});

test('a homepage is optional: with one it is checked and indexed, without one the entry has none', async () => {
  const source = origin('homed', { 'fixture.meaning.yaml': meaningFile(), LICENSE: 'CC0 1.0 Universal\n' });
  const dir = registry((d) => writeRecord(d, 'graphs', 'homed', fixtureRecord(source, { homepage: 'https://graphs.example.com/fixture/' })));
  assert.deepEqual((await check(dir)).problems, []);
  const text = readFileSync(join(dir, 'index.json'), 'utf8');
  const entry = JSON.parse(text).graphs.find((graph) => graph.id === 'homed');
  assert.equal(entry.homepage, 'https://graphs.example.com/fixture/');
  assert.equal(Object.keys(entry)[Object.keys(entry).indexOf('status') + 1], 'homepage', 'homepage sits after status, wherever the record file wrote it');
  assert.match(text, /^ {6}"homepage": "https:\/\/graphs\.example\.com\/fixture\/",$/m);
  // Without one, the entry has no homepage, and neither has the committed core graph.
  const plain = registry((d) => writeRecord(d, 'graphs', 'plain', fixtureRecord(source)));
  assert.deepEqual((await check(plain)).problems, []);
  const plainIndex = JSON.parse(readFileSync(join(plain, 'index.json'), 'utf8'));
  assert.equal('homepage' in plainIndex.graphs.find((graph) => graph.id === 'plain'), false);
  assert.equal('homepage' in plainIndex.graphs.find((graph) => graph.id === 'core'), false);
  // The checksum covers the entry, so a homepage added to a record with no new index is stale.
  const stale = registry((d) => writeRecord(d, 'graphs', 'plain', fixtureRecord(source)));
  writeRecord(stale, 'graphs', 'plain', fixtureRecord(source, { homepage: 'https://graphs.example.com/fixture/' }));
  expectProblem((await check(stale)).problems, /^index\.json differs from the records/);
});

// What a homepage is allowed to be, as README.md states it for index.json.
const legitimateHomepages = [
  'https://chinook.demodb.dev/model/',
  'https://example.com/',
  'https://graphs.example.com/fixture/',
  'https://github.com/datatug/chinookdb/',
  'https://datatug.github.io/chinookdb/model',
  'https://en.wikipedia.org/wiki/Chinook_database',
  'https://xn--mnchen-3ya.de/',
  'https://a.b.c.example.org/x/',
  'https://example.co.uk/a/b-c_d.e~f',
  'https://example.com/docs/v1.2/index.html',
  'https://sub-domain.example.com/',
  'https://a--b.example.com/',
  'https://1.example.com/',
  'https://example.com/CamelCase/Path',
  'https://www.meaninggraph.io/graphs/chinook/',
  'https://x.io/',
  `https://example.com/${'a'.repeat(200 - 'https://example.com/'.length)}`,
];
// Spellings that the first version of the check let through and that are refused now, with the reason.
const nowRefusedHomepages = {
  'https://en.wikipedia.org/wiki/Chinook_(database)': /character outside A-Z a-z 0-9 \. _ ~ \/ - in its path/, // parentheses are outside the path set
  'https://example.com/it%27s': /percent escape/, // an apostrophe is written as itself or left out, and itself is refused
  'https://example.com/a+b': /character outside/,
  'https://example.com/a,b': /character outside/,
  'https://example.com/a:b': /character outside/,
  'https://example.com/a@b': /character outside/,
};
const refusedHomepages = {
  // Characters that break out of an HTML attribute, in the host and in the path.
  'https://x"onmouseover="alert(1)"y=".example.com/': /is not a host name/,
  "https://x'onmouseover='alert(1)'y='.example.com/": /is not a host name/,
  'https://exa`mple.com/': /is not a host name/,
  'https://exa{mple.com/': /is not a host name/,
  'https://exa}mple.com/': /is not a host name/,
  'https://exa&mple.com/': /is not a host name/,
  'https://exa!mple.com/': /is not a host name/,
  'https://exa*mple.com/': /is not a host name/,
  'https://exa_mple.com/': /is not a host name/,
  "https://example.com/'onmouseover='alert(1)'y='": /character outside/,
  'https://example.com/"onmouseover="alert(1)': /character outside|percent escape/,
  'https://example.com/`onmouseover=`': /character outside|percent escape/,
  'https://example.com/<script>alert(1)</script>': /character outside|percent escape/,
  'https://example.com/a&b': /character outside/,
  'https://example.com/a&quot;b': /character outside/,
  'https://example.com/a|b': /character outside/,
  'https://example.com/a[0]': /character outside/,
  'https://example.com/a;b': /character outside/,
  'https://example.com/a=b': /character outside/,
  'https://example.com/a!b': /character outside/,
  'https://example.com/a$b': /character outside/,
  'https://example.com/a*b': /character outside/,
  // Percent escapes: none at all, so each URL has one spelling.
  'https://example.com/%': /percent escape/,
  'https://example.com/%zz': /percent escape/,
  'https://example.com/%00': /percent escape/,
  'https://example.com/%0d%0a': /percent escape/,
  'https://example.com/%ff': /percent escape/,
  'https://example.com/%C3%A9': /percent escape/,
  'https://example.com/%c3%a9': /percent escape/,
  'https://example.com/%61': /percent escape/,
  'https://example.com/%2e%2e/x': /percent escape/,
  // No port at all.
  'https://example.com:443/': /must not name a port/,
  'https://example.com:0/': /must not name a port/,
  'https://example.com:22/': /must not name a port/,
  'https://example.com:6379/': /must not name a port/,
  'https://example.com:8443/': /must not name a port/,
  'https://example.com:/': /must not name a port/,
  // Host shapes.
  'https://-a.example.com/': /is not a host name/,
  'https://a-.example.com/': /is not a host name/,
  [`https://${'a'.repeat(64)}.example.com/`]: /is not a host name/,
  'https://münchen.de/': /is not written canonically \(it would be https:\/\/xn--mnchen-3ya\.de\/\)/,
  'https://Graphs.Example.com/': /is not written canonically/,
  'https://graphs.example.com': /is not written canonically \(it would be https:\/\/graphs\.example\.com\/\)/,
  'https://graphs.example.com./': /ends with a dot/,
  'https://models..example.com/': /has an empty label/,
  'https://localhost/': /single-label name/,
  'https://localhost:8443/': /single-label name/,
  'https://app.localhost/': /\.localhost\)/,
  'https://printer.local/': /\.local\)/,
  'https://wiki.internal/': /\.internal\)/,
  'https://router.home.arpa/': /\.home\.arpa\)/,
  'https://models.test/': /\.test\)/,
  'https://models.example/': /\.example\)/,
  'https://abcdefghij.onion/': /\.onion\)/,
  // Addresses, in every spelling.
  'https://127.0.0.1/': /is an IP address/,
  'https://10.0.0.5/model/': /is an IP address/,
  'https://169.254.169.254/latest/': /is an IP address/,
  'https://2130706433/': /is an IP address/,
  'https://0x7f.1/': /is an IP address/,
  'https://[::1]/': /is an IP address/,
  'https://[::ffff:7f00:1]/': /is an IP address/,
  // Scheme, userinfo, query, fragment.
  'http://graphs.example.com/': /must be https, not http/,
  'ftp://graphs.example.com/': /must be https, not ftp/,
  'javascript:alert(1)': /must be https, not javascript/,
  'data:text/html,x': /must be https, not data/,
  '//graphs.example.com/': /is not a URL/,
  'graphs.example.com': /is not a URL/,
  'https://user@graphs.example.com/': /must not contain credentials/,
  'https://user:secret@graphs.example.com/': /must not contain credentials/,
  'https://@graphs.example.com/': /must not contain credentials|is not written canonically/,
  'https://graphs.example.com/?a=1': /must not contain a query/,
  'https://graphs.example.com/?': /must not contain a query/,
  'https://graphs.example.com/#top': /must not contain a fragment/,
  'https://graphs.example.com/#': /must not contain a fragment/,
  'https://github.com/org/repo#readme': /must not contain a fragment/,
  'https://graphs.example.com/#/model': /must not contain a fragment/,
  // Path shapes.
  'https://graphs.example.com//x': /empty path segment/,
  'https://graphs.example.com/a/../b': /\. or \.\. segment/,
  'https://graphs.example.com/a/./b': /\. or \.\. segment/,
  'https://graphs.example.com/..': /\. or \.\. segment/,
  // Whitespace, control characters, length.
  'https://graphs.example.com/a b': /whitespace/,
  ' https://graphs.example.com/': /whitespace/,
  'https://graphs.example.com/\\x': /backslash/,
  'https://graphs.example.com/\u0000': /control characters/,
  'https://graphs.example.com/\u00a0': /whitespace/,
  '': /is not a URL/,
  '   ': /is not a URL/,
  [`https://example.com/${'a'.repeat(200 - 'https://example.com/'.length + 1)}`]: /longer than 200 characters/,
};

test('the URLs a homepage may be, and the ones it may not: legitimate ones are kept, every payload is refused with its reason', () => {
  const problems = (homepage) => recordProblems({ graphs: [{ key: 'x', file: 'graphs/$records/x.yaml', data: { ...readRecord(root, 'graphs', 'core'), homepage } }], dependencies: [], ...context });
  assert.equal(legitimateHomepages.length, 17);
  for (const homepage of legitimateHomepages) {
    assert.equal(homepageProblem(homepage), null, homepage);
    assert.deepEqual(problems(homepage), [], homepage);
    // Whatever is accepted is made of letters, digits and - . _ ~ / : only: nothing that needs escaping in HTML, a URL or a shell.
    assert.match(homepage, /^[A-Za-z0-9._~/:-]+$/, homepage);
  }
  for (const [homepage, pattern] of Object.entries({ ...refusedHomepages, ...nowRefusedHomepages })) {
    expectProblem(problems(homepage), new RegExp(`^graphs/\\$records/x\\.yaml: homepage: .*${pattern.source}`));
    assert.match(homepageProblem(homepage), pattern, JSON.stringify(homepage));
  }
  for (const homepage of [5, 1.5, true, null, '', ['https://graphs.example.com/'], { url: 'https://graphs.example.com/' }]) {
    expectProblem(problems(homepage), /^graphs\/\$records\/x\.yaml: homepage: is not a URL/);
  }
  assert.equal(maxHomepageLength, 200);
  assert.equal(publicHttpsProblem('https://graphs.example.com/'), null);
  assert.deepEqual(problems(undefined), []);
  // The real thing: every character U+0000 to U+FFFF in the host and in the path, accepted or refused.
  for (let code = 0; code <= 0xffff; code += 1) {
    const character = String.fromCharCode(code);
    if (homepageProblem(`https://a${character}b.example.com/`) === null) assert.match(character, /^[a-z0-9.-]$/, `host character U+${code.toString(16)} accepted`);
    if (homepageProblem(`https://example.com/a${character}b`) === null) assert.match(character, /^[A-Za-z0-9._~/-]$/, `path character U+${code.toString(16)} accepted`);
  }
});

test('a refused homepage fails the whole check and is never requested: git is asked for repositories only', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'core', { ...readRecord(d, 'graphs', 'core'), homepage: 'http://graphs.example.com/' }));
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the checks must not fetch a homepage'); };
  let result;
  try { result = await checkRegistry({ root: dir, urlFor: (url) => { asked.push(url); return urlFor(url); }, cacheDir, ...seen }); } finally { globalThis.fetch = realFetch; }
  expectProblem(result.problems, /^graphs\/\$records\/core\.yaml: homepage: must be https, not http/);
  assert.ok(asked.length > 0 && asked.every((url) => /^https:\/\/github\.com\/(demo-db\/(adventureworks|chinook|employees|northwind|pubs|sakila)|ingitdb\/(geo-ingitdb|ror-ingitdb)|meaninggraph\/core|openvaultdb\/ovdb)$/.test(url)), `asked for ${asked.join(', ')}`);
});

test('a record has declared columns only: an undeclared key, an id override and a merge key are refused, and none reaches the index', async () => {
  const columns = readRegistry(root).columns;
  assert.deepEqual(columns.graphs.slice(0, 7), ['format', 'title', 'description', 'kind', 'status', 'homepage', 'address']);
  assert.ok(!columns.graphs.includes('id') && !columns.graphs.includes('<<'));
  const chinook = readRecord(root, 'graphs', 'chinook');
  for (const [name, extra, pattern] of [
    ['an undeclared key', { colour: 'blue' }, /^graphs\/\$records\/chinook\.yaml: "colour" is not a column of this collection/],
    ['an id override', { id: 'evil' }, /^graphs\/\$records\/chinook\.yaml: "id" is not a column of this collection/],
    ['a key that only differs in case', { Homepage: 'https://graphs.example.com/' }, /"Homepage" is not a column of this collection/],
    ['a depends key', { depends: [] }, /"depends" is not a column of this collection/],
  ]) {
    const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...chinook, ...extra }), { rebuildIndex: false });
    const read = readRegistry(dir);
    expectProblem(recordProblems(read), pattern);
    const entry = JSON.parse(buildIndex(read)).graphs.find((graph) => graph.id === 'chinook');
    assert.equal(entry.id, 'chinook', `${name}: the id is the file name`);
    for (const key of Object.keys(extra).filter((key) => key !== 'id')) assert.equal(key in entry && key !== 'depends', false, `${name}: ${key} is not in the entry`);
    assert.deepEqual(entry.depends, [{ id: 'core', commit: '982916d73f0a35ff2558b0062f58aa3ac4f24d97' }]);
  }
  // A YAML merge key hides a homepage from the URL check; it is refused in every spelling the reader
  // would merge: plain, quoted, as a complex key, with an explicit tag, and under a %YAML 1.1 directive.
  const base = stringifyYaml(chinook).replace(/^homepage: .*\n/m, '');
  const merged = "{homepage: 'javascript:alert(1)'}";
  const spellings = {
    'a plain key': `${base}<<: ${merged}\n`,
    'a double-quoted key': `${base}"<<": ${merged}\n`,
    'a single-quoted key': `${base}'<<': ${merged}\n`,
    'a complex key': `${base}? <<\n: ${merged}\n`,
    'a !!merge key': `${base}!!merge <<: ${merged}\n`,
    'a verbatim merge tag': `${base}!<tag:yaml.org,2002:merge> <<: ${merged}\n`,
    'a %YAML 1.1 directive': `%YAML 1.1\n---\n${base}<<: ${merged}\n`,
  };
  assert.ok('homepage' in parseYaml(spellings['a plain key'], { merge: true }), 'positive control: a parser that merges would give the record this homepage');
  assert.equal(parseYaml(spellings['a !!merge key'], { merge: false }).homepage, 'javascript:alert(1)', 'positive control: merge: false alone still merges a !!merge key');
  assert.equal(parseYaml(spellings['a %YAML 1.1 directive'], { merge: false }).homepage, 'javascript:alert(1)', 'positive control: merge: false alone still merges under %YAML 1.1');
  for (const [name, text] of Object.entries(spellings)) {
    const dir = registry((d) => writeFileSync(record(d, 'graphs', 'chinook'), text), { rebuildIndex: false });
    const problems = [...readRegistry(dir).problems, ...recordProblems(readRegistry(dir))];
    expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: "<<" merge keys are not allowed/);
    assert.equal(problems.filter((problem) => /merge keys are not allowed/.test(problem)).length, 1, `${name}: reported once`);
    if (name.includes('%YAML')) expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: a %YAML directive is not allowed/);
  }
  const dir = registry((d) => writeFileSync(record(d, 'graphs', 'chinook'), spellings['a !!merge key']), { rebuildIndex: false });
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: "<<" merge keys are not allowed/);
  // A %YAML directive is refused on its own: under 1.1, `title: yes` is the boolean true and `title: 1:30` the number 90.
  for (const directive of ['%YAML 1.1\n---\n', '%YAML 1.2\n---\n']) {
    const bare = registry((d) => writeFileSync(record(d, 'graphs', 'chinook'), `${directive}${stringifyYaml(chinook)}`), { rebuildIndex: false });
    expectProblem(readRegistry(bare).problems, /^graphs\/\$records\/chinook\.yaml: a %YAML directive is not allowed/);
  }
  assert.equal(parseYaml('%YAML 1.1\n---\ntitle: yes\n').title, true, 'positive control: 1.1 reads yes as a boolean');
  // An ordinary record, and `title: yes` without a directive, are read as written.
  const ordinary = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...chinook, title: 'yes' }), { rebuildIndex: false });
  assert.equal(readRegistry(ordinary).graphs.find((graph) => graph.key === 'chinook').data.title, 'yes');
  assert.deepEqual(readRegistry(ordinary).problems, []);
  // Dependency and maintainer records are held to their collections' columns too, and a record must be a mapping.
  const other = registry((d) => {
    writeRecord(d, 'dependencies', 'chinook--core', { ...readRecord(d, 'dependencies', 'chinook--core'), extra: 1 });
    writeFileSync(record(d, 'maintainers', 'trakhimenok'), 'name: A\nrole: admin\n');
    writeFileSync(record(d, 'graphs', 'core'), '- a\n- b\n');
  }, { rebuildIndex: false });
  const problems = recordProblems(readRegistry(other));
  expectProblem(problems, /^dependencies\/\$records\/chinook--core\.yaml: "extra" is not a column of this collection/);
  expectProblem(problems, /^maintainers\/\$records\/trakhimenok\.yaml: "role" is not a column of this collection/);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: a record is a mapping of columns/);
});

test('a definition whose columns_order does not list exactly its columns, or that declares id or depends, is refused', () => {
  const definition = (dir) => join(dir, 'graphs', '.collection', 'definition.yaml');
  const edited = (change) => {
    const dir = registry(undefined, { rebuildIndex: false });
    const doc = parseYaml(readFileSync(definition(dir), 'utf8'));
    change(doc);
    writeFileSync(definition(dir), stringifyYaml(doc));
    return readRegistry(dir);
  };
  const rule = /^graphs\/\.collection\/definition\.yaml: columns_order must list exactly the declared columns \(format, title, /;
  expectProblem(edited((doc) => { doc.columns_order = doc.columns_order.filter((column) => column !== 'homepage'); }).problems, rule);
  expectProblem(edited((doc) => { doc.columns_order = [...doc.columns_order, 'title']; }).problems, rule);
  expectProblem(edited((doc) => { doc.columns_order = [...doc.columns_order, 'colour']; }).problems, rule);
  expectProblem(edited((doc) => { doc.columns_order = doc.columns_order.join(','); }).problems, rule);
  expectProblem(edited((doc) => { doc.columns_order = doc.columns_order.map((column) => (column === 'homepage' ? 'title' : column)); }).problems, rule);
  assert.deepEqual(edited((doc) => { doc.columns_order = [...doc.columns_order].reverse(); }).problems, [], 'any order that lists every column is allowed, and is the order of the index');
  // `id` and `depends` are the index entry's own: a definition may not declare them as columns.
  for (const reserved of ['id', 'depends']) {
    const read = edited((doc) => { doc.columns[reserved] = { type: 'string' }; doc.columns_order.push(reserved); });
    expectProblem(read.problems, new RegExp(`^graphs/\\.collection/definition\\.yaml: "${reserved}" cannot be a column: an index entry's id is the record's file name and its depends comes from the dependency records`));
    assert.ok(!read.columns.graphs.includes(reserved));
  }
  // Even so, the entry's id is the file name: a record with an `id` is refused and the index ignores it.
  const dir = registry(undefined, { rebuildIndex: false });
  const doc = parseYaml(readFileSync(definition(dir), 'utf8'));
  doc.columns.id = { type: 'string' };
  doc.columns_order.push('id');
  writeFileSync(definition(dir), stringifyYaml(doc));
  writeRecord(dir, 'graphs', 'chinook', { ...readRecord(dir, 'graphs', 'chinook'), id: 'evil' });
  const read = readRegistry(dir);
  assert.deepEqual(JSON.parse(buildIndex(read)).graphs.map((graph) => graph.id), read.graphs.map((graph) => graph.key).sort());
  expectProblem([...read.problems, ...recordProblems(read)], /"id" is not a column of this collection/);
});

test('the order of an index entry is the definition\'s columns_order, whatever the order of the keys in the record file', () => {
  const chinook = readRecord(root, 'graphs', 'chinook');
  const shuffled = Object.fromEntries(Object.entries(chinook).reverse());
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(chinook));
  const first = registry((d) => writeRecord(d, 'graphs', 'chinook', chinook), { rebuildIndex: false });
  const second = registry((d) => writeRecord(d, 'graphs', 'chinook', shuffled), { rebuildIndex: false });
  assert.equal(buildIndex(readRegistry(second)), buildIndex(readRegistry(first)));
  const entry = JSON.parse(buildIndex(readRegistry(second))).graphs.find((graph) => graph.id === 'chinook');
  assert.deepEqual(Object.keys(entry), ['id', ...readRegistry(root).columns.graphs.filter((column) => column !== 'tag'), 'depends']);
  assert.equal(buildIndex(readRegistry(first)), readFileSync(join(root, 'index.json'), 'utf8'), 'the committed index.json is what the definition order writes');
});

test('the suite\'s git calls ignore the user\'s git configuration: a decoy global config that breaks every commit changes nothing', () => {
  const home = join(scratch, `decoy-home-${count++}`);
  mkdirSync(home);
  // Every commit signs with a program that always fails, as commit.gpgsign=true with no usable key does.
  writeFileSync(join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const plain = join(scratch, `decoy-plain-${count++}`);
  mkdirSync(plain);
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  // The control runs git with the process environment minus every GIT_ variable (an inherited GIT_DIR or
  // GIT_WORK_TREE would send it into another repository) and keeps the decoy HOME; and only inside `plain`.
  const controlEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const control = (...args) => {
    assert.ok(realpathSync(plain).startsWith(`${realpathSync(scratch)}${sep}`), 'the control runs only inside the test\'s temporary directory');
    return execFileSync('git', ['-C', plain, ...args], { stdio: 'pipe', env: controlEnv }).toString();
  };
  try {
    // Positive control: git with that environment and no protection does not get a commit through.
    control('init', '-q');
    assert.equal(control('rev-parse', '--absolute-git-dir').trim(), join(realpathSync(plain), '.git'), 'the control repository is the one in the temporary directory');
    assert.throws(() => control('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '--allow-empty', '-m', 'x'), /gpg failed to sign the data/, 'the decoy configuration is read by an unprotected git');
    // The fixture helper commits anyway.
    const source = origin('decoy', { 'fixture.meaning.yaml': meaningFile(), LICENSE: 'CC0 1.0 Universal\n' });
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    assert.equal(gitEnv().GIT_CONFIG_GLOBAL, devNull);
    assert.equal(gitEnv().GIT_CONFIG_NOSYSTEM, '1');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('index.json is sorted by code unit, whatever the locale', () => {
  const ids = ['ya', 'ia', 'a0', 'ab', 'a-b', 'aa'];
  const index = JSON.parse(buildIndex({ graphs: ids.map((key) => ({ key, data: {} })), dependencies: [], columns: readRegistry(root).columns }));
  assert.deepEqual(index.graphs.map((graph) => graph.id), ['a-b', 'a0', 'aa', 'ab', 'ia', 'ya']);
});

test('a cached checker checkout is reused only after untracked and ignored files are removed', () => {
  const source = origin('cache', { 'scripts/lib/meaning.mjs': 'export const ok = true;\n', '.gitignore': 'node_modules/\n' });
  const cache = join(scratch, `fetch-cache-${count++}`);
  const dir = fetchCommit(origins.get(source.repository), source.commit, cache);
  writeFileSync(join(dir, 'planted.mjs'), 'planted\n');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'planted.js'), 'planted\n');
  writeFileSync(join(dir, 'scripts', 'lib', 'meaning.mjs'), 'export const ok = false;\n');
  assert.equal(fetchCommit(origins.get(source.repository), source.commit, cache), dir);
  assert.equal(existsSync(join(dir, 'planted.mjs')), false);
  assert.equal(existsSync(join(dir, 'node_modules')), false);
  assert.equal(readFileSync(join(dir, 'scripts', 'lib', 'meaning.mjs'), 'utf8'), 'export const ok = true;\n');
});

// S2-r2: one spelling per repository, on an allow-listed host, refused before git runs.
test('dot segments, host aliases, IP literals and a .GIT suffix are refused before git runs', async () => {
  for (const repository of [
    'https://github.com/datatug/chinookdb/.',
    'https://github.com/datatug/./chinookdb',
    'https://github.com/datatug/x/../chinookdb',
    'https://www.github.com/datatug/chinookdb',
    'https://127.0.0.1/a/b',
    'https://github.com/meaninggraph/../datatug/chinookdb',
    'https://github.com/datatug/chinookdb.GIT',
    'https://github.com:443/datatug/chinookdb',
    'https://user@github.com/datatug/chinookdb',
  ]) {
    const dir = registry((d) => {
      writeRecord(d, 'graphs', 'chinook-dup', { ...readRecord(d, 'graphs', 'chinook'), repository, address: `meaning://${repository.slice('https://'.length)}` });
      writeRecord(d, 'dependencies', 'chinook-dup--core', { ...readRecord(d, 'dependencies', 'chinook--core'), graph: 'chinook-dup' });
    });
    const asked = [];
    const { problems } = await checkRegistry({ root: dir, urlFor: (url) => { asked.push(url); return urlFor(url); }, cacheDir, ...seen });
    expectProblem(problems, /^graphs\/\$records\/chinook-dup\.yaml: repository must be an https URL of a repository on github\.com/);
    assert.ok(!asked.includes(repository), `${repository} reached git`);
  }
});

test('an unsuffixed LICENSE the check does not recognise is still the default, so the file must declare', async () => {
  const source = origin('licence-unrecognised', { 'fixture.meaning.yaml': meaningFile(), 'm.modelspec.json': '{}', LICENSE: 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n', 'LICENSE-CC0': CC0 });
  const dir = registry((d) => writeRecord(d, 'graphs', 'licence-unrecognised', fixtureRecord(source, { model_files: ['m.modelspec.json'], model_licence: 'CC0-1.0' })));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/licence-unrecognised\.yaml: m\.modelspec\.json declares no licence, and the repository's LICENSE file names no licence the check recognises; the file must declare its licence/);
});

test('inherited GIT_* repository variables cannot redirect the git commands', () => {
  const source = origin('environment', { README: 'x\n' });
  const url = origins.get(source.repository);
  const bogus = join(scratch, `not-a-repository-${count++}`);
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_CONFIG_PARAMETERS'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { GIT_DIR: bogus, GIT_WORK_TREE: bogus, GIT_INDEX_FILE: join(bogus, 'index'), GIT_OBJECT_DIRECTORY: bogus, GIT_CONFIG_PARAMETERS: "'protocol.allow=never'" });
  try {
    assert.equal(defaultBranch(url), 'main');
    const dir = fetchCommit(url, source.commit, join(scratch, `env-cache-${count++}`));
    assert.equal(readFileSync(join(dir, 'README'), 'utf8'), 'x\n');
    assert.equal(existsSync(bogus), false, 'nothing was written where GIT_DIR pointed');
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
});

test('index.json that differs from the records fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), title: 'Chinook' }), { rebuildIndex: false });
  expectProblem((await check(dir)).problems, /^index\.json differs from the records; run npm run index and commit it$/);
});

test('index.json carries a checksum of its graphs array', () => {
  const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  const sha = execFileSync('shasum', ['-a', '256'], { input: JSON.stringify(index.graphs) }).toString().split(' ')[0];
  assert.equal(index.checksum, `sha256:${sha}`);
  assert.deepEqual(index.graphs.map((graph) => graph.id), readRegistry(root).graphs.map((graph) => graph.key).sort());
  const chinook = index.graphs.find((graph) => graph.id === 'chinook');
  const core = index.graphs.find((graph) => graph.id === 'core');
  assert.equal(chinook.homepage, 'https://chinook.demodb.dev/model/');
  assert.deepEqual(Object.keys(chinook).slice(0, 7), ['id', 'format', 'title', 'description', 'kind', 'status', 'homepage']);
  assert.equal('homepage' in core, false, 'the core graph has no homepage');
  assert.deepEqual(chinook.depends, [{ id: 'core', commit: '982916d73f0a35ff2558b0062f58aa3ac4f24d97' }]);
});

test('a file declares its licence in its first lines or in a meaning file field', () => {
  assert.equal(declaredLicence('a.meaning.yaml', '', { license: 'CC0-1.0' }), 'CC0-1.0');
  assert.equal(declaredLicence('m.hcl', '# Licence: MIT (https://example.test/LICENSE).\n', null), 'MIT');
  assert.equal(declaredLicence('m.go', '// SPDX-License-Identifier: Apache-2.0\n', null), 'Apache-2.0');
  assert.equal(declaredLicence('m.json', '{"modelspec": "1.0-draft"}', null), null);
});

// The git cache. git without the two -c settings the checker passes, and
// without the user's own configuration (which may set a hooks path of its
// own), shows what a planted repository would have done.
// (gitEnv() minus GIT_NO_REPLACE_OBJECTS: a positive control must honour replace refs.)
const plainGit = (args, options = {}) => execFileSync('git', args, { stdio: 'pipe', env: (({ GIT_NO_REPLACE_OBJECTS, ...rest }) => rest)(gitEnv()), ...options }).toString().trim();
const script = (path, word, marker) => { writeFileSync(path, `#!/bin/sh\necho ${word} >> '${marker}'\n`); chmodSync(path, 0o755); return path; };
// A script as a command in git's configuration: git runs that through the shell, and the temporary directory may have a space in its path.
const quoted = (path) => `'${path}'`;
const hooks = ['reference-transaction', 'post-index-change', 'post-checkout'];
// Hooks in the git directory `gitDir` that only record, in `marker`, that they ran.
const plantHooks = (gitDir, marker) => {
  mkdirSync(join(gitDir, 'hooks'), { recursive: true });
  for (const hook of hooks) script(join(gitDir, 'hooks', hook), hook, marker);
};

// An index that says the file at `path` of the checkout `dir` is the commit's
// own, while it holds `content`: the altered file is added, then the commit's
// blob id is written back over the new one in the index (and the index
// checksum redone). The file is older than the index, so git does not read
// it again to compare.
function forgeIndex(dir, path, content) {
  const own = (args) => plainGit(['--git-dir', join(dir, '.git'), '--work-tree', dir, ...args]);
  const genuine = own(['rev-parse', `HEAD:${path}`]);
  writeFileSync(join(dir, path), content);
  const before = new Date(Date.now() - 60_000);
  utimesSync(join(dir, path), before, before);
  own(['add', '--', path]);
  const index = readFileSync(join(dir, '.git', 'index'));
  Buffer.from(genuine, 'hex').copy(index, index.indexOf(Buffer.from(own(['rev-parse', `:${path}`]), 'hex')));
  createHash('sha1').update(index.subarray(0, -20)).digest().copy(index, index.length - 20);
  writeFileSync(join(dir, '.git', 'index'), index);
  assert.equal(own(['status', '--porcelain', '--ignored', '--untracked-files=all']), '', 'git reports no difference');
  assert.equal(own(['ls-files', '-v']).split('\n').every((line) => line.startsWith('H ')), true, 'no entry is flagged');
}

test('git runs no hook from a hooks directory and no fsmonitor of a repository it works in', () => {
  const source = origin('hooks', { README: 'x\n' });
  const dir = fileURLToPath(origins.get(source.repository));
  const marker = join(scratch, `MARKER-${count++}`);
  plantHooks(join(dir, '.git'), marker);
  plainGit(['-C', dir, 'config', 'core.fsmonitor', quoted(script(join(scratch, `fsmonitor-${count++}`), 'fsmonitor', marker))]);
  const commands = [['status'], ['update-ref', 'refs/heads/planted', 'HEAD'], ['read-tree', '--reset', '-u', 'HEAD'], ['checkout', '-q', '-B', 'other']];
  for (const args of commands) git(['-C', dir, ...args]);
  assert.equal(existsSync(marker), false, 'a hook or the fsmonitor ran');
  // The same commands without the checker's settings run every one of them.
  for (const args of commands) plainGit(['-C', dir, ...args]);
  const ran = readFileSync(marker, 'utf8');
  for (const name of ['fsmonitor', ...hooks]) assert.match(ran, new RegExp(`^${name}$`, 'm'), `${name} is a live plant`);
});

test('a repository planted in the registry\'s .cache never runs: untracked it is not read, tracked the check refuses', async () => {
  assert.deepEqual((await check(root)).problems, []);
  const marker = join(scratch, `MARKER-${count++}`);
  // Where the history of meaninggraph/core's main was kept while the cache was
  // in the registry, and so where git would have fetched into a planted clone.
  const key = createHash('sha256').update(`${checkerRepository}#main`).digest('hex').slice(0, 32);
  let planted;
  const dir = registry((d) => {
    planted = join(d, '.cache', 'history', key);
    cpSync(join(cacheDir, 'history', key), planted, { recursive: true });
    plantHooks(planted, marker);
  });
  after(() => rmSync(cacheDirFor(dir), { recursive: true, force: true }));
  // The default cache directory: outside the registry, so the plant is not read.
  const untracked = await checkRegistry({ root: dir, urlFor });
  assert.deepEqual(untracked.problems, []);
  assert.equal(existsSync(marker), false, 'a planted hook ran');
  assert.ok(existsSync(join(cacheDirFor(dir), 'history', key)), 'the history is kept in the cache directory outside the registry');
  assert.deepEqual([readdirSync(join(dir, '.cache')), readdirSync(join(dir, '.cache', 'history'))], [['history'], [key]], 'nothing is written to the registry\'s .cache');
  // Committed with the registry, as a pull request would bring it.
  plainGit(['-C', dir, 'init', '-q']);
  plainGit(['-C', dir, 'add', '--force', '--', '.cache']);
  const tracked = await checkRegistry({ root: dir, urlFor });
  assert.equal(tracked.problems.length, 1);
  assert.match(tracked.problems[0], new RegExp(`^cache: \\.cache is tracked \\(\\.cache/history/${key}/\\S+ and \\d+ more\\); the checker keeps its git cache outside the registry and does not run on one that commits a cache`));
  assert.equal(tracked.checker, undefined, 'nothing was fetched or checked');
  assert.equal(existsSync(marker), false, 'a planted hook ran');
  // The plant is live: the fetch the checker made into this directory moves a ref, and that runs the hook.
  plainGit(['-C', planted, 'update-ref', 'refs/heads/moved', readRecord(root, 'graphs', 'core').commit]);
  assert.match(readFileSync(marker, 'utf8'), /^reference-transaction$/m);
});

test('a cached checkout is reused when intact, and fetched again when an object is forged or its configuration is not git\'s own', (t) => {
  const notes = t.mock.method(console, 'error', () => {});
  const genuine = 'export const ok = true;\n';
  const forged = 'export const ok = false;\n';
  const source = origin('forged', { 'checker.mjs': genuine });
  const url = origins.get(source.repository);
  const cache = join(scratch, `forged-cache-${count++}`);
  const dir = fetchCommit(url, source.commit, cache);
  const gitDir = join(dir, '.git');
  const own = (args, options) => plainGit(['--git-dir', gitDir, '--work-tree', dir, ...args], options);
  const sentinel = join(gitDir, 'sentinel');
  const refetched = () => {
    writeFileSync(sentinel, '');
    assert.equal(fetchCommit(url, source.commit, cache), dir);
    assert.equal(readFileSync(join(dir, 'checker.mjs'), 'utf8'), genuine);
    return !existsSync(sentinel);
  };
  assert.equal(refetched(), false, 'an intact checkout is reused');
  assert.equal(intactCheckout(dir), true);
  // What a git that keeps its refs another way writes is git's own too.
  for (const [key, value] of [['core.repositoryformatversion', '1'], ['extensions.refstorage', 'files'], ['extensions.objectformat', 'sha1']]) own(['config', key, value]);
  assert.equal(refetched(), false, 'a checkout with the extensions git writes is reused');
  assert.equal(notes.mock.callCount(), 0, 'nothing is noted while the checkout is reused');
  // Attributes left in the work tree would decide how git writes the files.
  writeFileSync(join(dir, '.gitattributes'), '/checker.mjs text eol=crlf\n');
  assert.equal(refetched(), false, 'the checkout is reused, written without the attributes');

  // Under the id of the file's blob, other content (as loose objects: git
  // reads a pack first). git checks the file out from it without complaint.
  const packs = join(gitDir, 'objects', 'pack');
  const moved = join(scratch, `packs-${count++}`);
  renameSync(packs, moved);
  mkdirSync(packs);
  for (const name of readdirSync(moved).filter((file) => file.endsWith('.pack'))) own(['unpack-objects', '-q'], { input: readFileSync(join(moved, name)) });
  const blob = own(['rev-parse', 'HEAD:checker.mjs']);
  const object = join(gitDir, 'objects', blob.slice(0, 2), blob.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), Buffer.from(forged)])));
  rmSync(join(dir, 'checker.mjs'));
  assert.equal(own(['rev-parse', 'HEAD']), source.commit);
  own(['read-tree', '--reset', '-u', 'HEAD']);
  own(['checkout-index', '--all', '--force']);
  assert.equal(readFileSync(join(dir, 'checker.mjs'), 'utf8'), forged, 'git checks out the forged content');
  assert.equal(intactCheckout(dir), false, 'git fsck finds the forged object');
  assert.equal(refetched(), true, 'a checkout with a forged object is fetched again');
  own(['fsck', '--no-dangling', '--no-progress']);

  // A replacement ref answers for the commit's tree with a tree that holds
  // the forged file. Every object is sound, and what a checkout had to pass
  // before accepts it: HEAD is the commit, the files are rewritten from it,
  // and nothing differs. The checker does not follow replacement refs.
  const forgedTree = own(['mktree'], { input: `100644 blob ${own(['hash-object', '-w', '--stdin'], { input: forged })}\tchecker.mjs\n` });
  own(['replace', own(['rev-parse', 'HEAD^{tree}']), forgedTree]);
  assert.equal(own(['rev-parse', 'HEAD']), source.commit);
  own(['read-tree', '--reset', '-u', 'HEAD']);
  own(['checkout-index', '--all', '--force']);
  assert.equal(own(['status', '--porcelain', '--ignored', '--untracked-files=all']), '');
  assert.equal(readFileSync(join(dir, 'checker.mjs'), 'utf8'), forged, 'git follows the replacement unless told not to');
  assert.equal(refetched(), false, 'the checkout is reused, with the replacement ignored');
  own(['replace', '-d', own(['rev-parse', 'HEAD^{tree}'], { env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } })]);

  // An index that keeps git from rewriting an altered file. What a checkout
  // had to pass before leaves the file as it is each time.
  const remade = () => {
    own(['read-tree', '--reset', '-u', 'HEAD']);
    own(['checkout-index', '--all', '--force']);
    assert.equal(readFileSync(join(dir, 'checker.mjs'), 'utf8'), forged, 'git leaves the altered file');
    refetched();
  };
  writeFileSync(join(dir, 'checker.mjs'), forged);
  own(['update-index', '--skip-worktree', 'checker.mjs']);
  remade();
  forgeIndex(dir, 'checker.mjs', forged);
  remade();

  // Configuration and files git did not write.
  const marker = join(scratch, `MARKER-${count++}`);
  const planted = quoted(script(join(scratch, `planted-${count++}`), 'planted', marker));
  for (const [what, change] of [
    ['an fsmonitor command', () => own(['config', 'core.fsmonitor', planted])],
    ['a hooks path', () => own(['config', 'core.hooksPath', join(gitDir, 'hooks')])],
    // git runs a hook its configuration defines wherever core.hooksPath points; this one would run when the index is written.
    ['a hook defined in the configuration', () => { own(['config', 'hook.planted.command', planted]); own(['config', 'hook.planted.event', 'post-index-change']); }],
    ['a filter', () => own(['config', 'filter.planted.smudge', 'cat'])],
    ['an include', () => own(['config', 'include.path', join(scratch, 'included')])],
    ['a second core.bare', () => own(['config', '--add', 'core.bare', 'true'])],
    ['grafts', () => writeFileSync(join(gitDir, 'info', 'grafts'), '')],
    ['attributes', () => writeFileSync(join(gitDir, 'info', 'attributes'), '* text eol=crlf\n')],
    ['alternates', () => writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${join(moved)}\n`)],
  ]) {
    change();
    assert.equal(refetched(), true, `a checkout with ${what} is fetched again`);
  }
  assert.equal(existsSync(marker), false, 'a planted command ran');
  assert.ok(notes.mock.calls.some((call) => call.arguments[0] === `note: the cached ${dir} is not used again (its configuration sets core.fsmonitor); it is fetched anew`), 'a discarded checkout is noted with the reason');
  // What is there in place of the checkout is deleted as it is: of a link to a directory, the link, and nothing in the directory.
  const elsewhere = join(scratch, `elsewhere-${count++}`);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'file'), '');
  for (const [what, put] of [['a link to a directory', () => symlinkSync(elsewhere, dir)], ['a file', () => writeFileSync(dir, '')]]) {
    rmSync(dir, { recursive: true });
    put();
    notes.mock.resetCalls();
    assert.equal(fetchCommit(url, source.commit, cache), dir);
    assert.equal(readFileSync(join(dir, 'checker.mjs'), 'utf8'), genuine, `${what} in place of the checkout is fetched again`);
    assert.deepEqual(notes.mock.calls.map((call) => call.arguments[0]), [`note: the cached ${dir} is not used again (it is not a directory); it is fetched anew`]);
    assert.deepEqual(readdirSync(elsewhere), ['file'], `${what}: what a link points to is not touched`);
  }
  // It is live: git with the checker's own settings runs the hook the configuration defines.
  own(['config', 'hook.planted.command', planted]);
  own(['config', 'hook.planted.event', 'post-index-change']);
  git(['--git-dir', gitDir, '--work-tree', dir, 'read-tree', '--reset', '-u', 'HEAD']);
  assert.match(readFileSync(marker, 'utf8'), /^planted$/m);
});

test('a kept graph checkout is verified, and loses its index, before the checker reads it', async () => {
  const source = origin('kept-graph', { 'fixture.meaning.yaml': meaningFile(), LICENSE: CC0 });
  const dir = registry((d) => writeRecord(d, 'graphs', 'kept-graph', fixtureRecord(source)));
  assert.deepEqual((await check(dir)).problems, []);
  const kept = join(cacheDir, 'graphs', source.commit);
  const sentinel = join(kept, '.git', 'sentinel');
  writeFileSync(sentinel, '');
  assert.deepEqual((await check(dir)).problems, []);
  assert.ok(existsSync(sentinel), 'an intact checkout is reused');
  plainGit(['config', '--file', join(kept, '.git', 'config'), 'core.hooksPath', join(kept, '.git', 'hooks')]);
  assert.deepEqual((await check(dir)).problems, []);
  assert.equal(existsSync(sentinel), false, 'a checkout with a hooks path is fetched again');
  // A meaning file altered behind a forged index would be read as the commit's: its licence is not the entry's.
  forgeIndex(kept, 'fixture.meaning.yaml', meaningFile({ license: 'MIT' }));
  assert.deepEqual((await check(dir)).problems, [], 'the altered file was read');
});

test('a kept graph checkout with an entry that cannot be deleted is a problem of that graph, not an exception', async (t) => {
  // File modes do not stop root, and there are none to set where there is no user id.
  if (!process.getuid || process.getuid() === 0) return t.skip('needs a user that a directory of mode 000 stops');
  const notes = t.mock.method(console, 'error', () => {});
  const source = origin('locked-graph', { 'fixture.meaning.yaml': meaningFile(), LICENSE: CC0 });
  const dir = registry((d) => writeRecord(d, 'graphs', 'locked-graph', fixtureRecord(source)));
  assert.deepEqual((await check(dir)).problems, []);
  const kept = join(cacheDir, 'graphs', source.commit);
  const locked = join(kept, 'locked');
  // Whatever happens below, the cache is left without an entry nothing can delete.
  t.after(() => { if (existsSync(locked)) { chmodSync(locked, 0o755); rmSync(locked, { recursive: true }); } });
  // A checkout that is reused loses its files. One that is not (here, its
  // configuration has a key git did not write) is deleted whole.
  for (const reused of [true, false]) {
    const what = reused ? 'a checkout that is reused' : 'a checkout that is not used again';
    if (!reused) plainGit(['config', '--file', join(kept, '.git', 'config'), 'core.hooksPath', 'x']);
    mkdirSync(locked);
    writeFileSync(join(locked, 'file'), '');
    chmodSync(locked, 0o000);
    const { problems } = await check(dir);
    assert.equal(problems.length, 1, `${what}: ${problems.join('\n')}`);
    assert.ok(problems[0].startsWith('graphs/$records/locked-graph.yaml: the cached checkout cannot be cleared: ') && problems[0].includes(locked), `${what}: ${problems[0]}`);
    assert.deepEqual(notes.mock.calls.map((call) => call.arguments[0]), reused ? [] : [`note: the cached ${kept} is not used again (its configuration sets core.hookspath); it cannot be deleted`], `${what}: nothing is said to be fetched anew while it cannot be`);
    notes.mock.resetCalls();
    chmodSync(locked, 0o755);
    assert.deepEqual((await check(dir)).problems, [], `${what}: once the entry can be deleted the checkout is used again`);
    assert.equal(existsSync(locked), false);
    // Only now is the checkout that is not reused fetched anew, and noted (what is left of it decides the reason).
    const noted = notes.mock.calls.map((call) => call.arguments[0]);
    assert.equal(noted.length, reused ? 0 : 1, `${what}: ${noted.join('\n')}`);
    if (!reused) assert.ok(noted[0].startsWith(`note: the cached ${kept} is not used again (`) && noted[0].endsWith('); it is fetched anew'), noted[0]);
    notes.mock.resetCalls();
  }
});

test('a kept branch history is reused when intact, and cloned again when it is not or cannot be brought up to date', (t) => {
  const notes = t.mock.method(console, 'error', () => {});
  const source = origin('kept-history', { README: 'x\n' });
  const url = origins.get(source.repository);
  const cache = join(scratch, `history-cache-${count++}`);
  assert.equal(onBranch(url, 'main', source.commit, cache), true);
  const dir = join(cache, readdirSync(cache)[0]);
  const sentinel = join(dir, 'sentinel');
  const cloned = (run) => {
    writeFileSync(sentinel, '');
    assert.equal(onBranch(url, 'main', source.commit, cache, new Set(), run), true);
    return !existsSync(sentinel);
  };
  assert.equal(cloned(), false, 'an intact clone is fetched into');
  const config = (...args) => plainGit(['config', '--file', join(dir, 'config'), ...args]);
  for (const [what, change] of [
    ['a rewritten URL', () => config(`url.file://${scratch}/elsewhere.insteadOf`, url)],
    ['another remote', () => config('remote.origin.url', `file://${scratch}/elsewhere`)],
    ['a hooks path', () => config('core.hooksPath', join(dir, 'hooks'))],
    ['a hook defined in the configuration', () => { config('hook.planted.command', 'true'); config('hook.planted.event', 'reference-transaction'); }],
    ['a shallow file', () => writeFileSync(join(dir, 'shallow'), `${source.commit}\n`)],
    // The branch has become a directory of refs, so the fetch cannot write it.
    ['a branch that cannot be fetched', () => { plainGit(['-C', dir, 'update-ref', '-d', 'refs/heads/main']); plainGit(['-C', dir, 'update-ref', 'refs/heads/main/x', source.commit]); }],
  ]) {
    change();
    assert.equal(cloned(), true, `a clone with ${what} is cloned again`);
    assert.equal(config('--get', 'remote.origin.url'), url);
  }
  // The last of them is a fetch git itself fails, in words (or with an end)
  // that depend on its version: git 2.54 and 2.55 print nothing and are
  // killed by SIGSEGV here.
  const [start, end] = [`note: the cached ${dir} is not used again (it cannot be brought up to date: `, '); it is fetched anew'];
  const note = () => notes.mock.calls.at(-1).arguments[0];
  assert.ok(note().startsWith(start) && note().endsWith(end), `the note was: ${note()}`);
  // The reason is the last line git printed, or, when it printed nothing, how
  // it ended (a killed process has no exit status). Each fetch here is a
  // process that ends as told; every other command is git's.
  const fetchEnds = (code) => (args, options) => (args[2] === 'fetch' ? execFileSync(process.execPath, ['-e', code], { stdio: 'pipe' }).toString() : git(args, options));
  for (const [how, code, reason] of [
    ['is killed', 'process.kill(process.pid, "SIGKILL")', 'git fetch was killed by SIGKILL'],
    ['ends with a status and prints nothing', 'process.exit(7)', 'git fetch ended with status 7'],
    ['ends with a status and prints only a blank line', 'console.error(""); process.exit(3)', 'git fetch ended with status 3'],
    ['prints why it failed', 'console.error("fatal: first"); console.error("fatal: the branch cannot be written"); process.exit(128)', 'fatal: the branch cannot be written'],
  ]) {
    assert.equal(cloned(fetchEnds(code)), true, `a clone whose fetch ${how} is cloned again`);
    assert.equal(note(), `${start}${reason}${end}`);
  }
});

test('a kept branch history with a forged commit does not put a side branch\'s commit on the branch', () => {
  // main: the first commit, then two more. side: one commit on the first.
  const source = origin('forged-history', { README: 'x\n' }, { side: { README: 'y\n' } });
  const url = origins.get(source.repository);
  const work = fileURLToPath(url);
  for (const message of ['second', 'third']) plainGit(['-C', work, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message]);
  const cache = join(scratch, `history-cache-${count++}`);
  assert.equal(onBranch(url, 'main', source.sideCommit, cache), false);
  const dir = join(cache, readdirSync(cache)[0]);
  // Another repository as the clone's remote, one whose main is the side
  // commit: the history of main is never read from it.
  const other = join(scratch, `other-${count++}`);
  plainGit(['clone', '-q', work, other]);
  plainGit(['-C', other, 'checkout', '-q', '-B', 'main', source.sideCommit]);
  plainGit(['config', '--file', join(dir, 'config'), 'remote.origin.url', `file://${other}`]);
  assert.equal(onBranch(url, 'main', source.sideCommit, cache), false, 'the history was read from another repository');
  // The clone is given the side commit, and under the id of main's second
  // commit a commit that also has the side commit as a parent (as loose
  // objects: git reads a pack first).
  plainGit(['-C', dir, 'fetch', '-q', url, 'refs/heads/side'], { env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: undefined, GIT_ALLOW_PROTOCOL: 'file' } });
  const packs = join(dir, 'objects', 'pack');
  const moved = join(scratch, `packs-${count++}`);
  renameSync(packs, moved);
  mkdirSync(packs);
  for (const name of readdirSync(moved).filter((file) => file.endsWith('.pack'))) plainGit(['-C', dir, 'unpack-objects', '-q'], { input: readFileSync(join(moved, name)) });
  const second = plainGit(['-C', dir, 'rev-parse', 'refs/heads/main~1']);
  const body = execFileSync('git', ['-C', dir, 'cat-file', 'commit', second], { env: gitEnv() }).toString().replace(/^(parent [0-9a-f]{40}\n)/m, `$1parent ${source.sideCommit}\n`);
  const object = join(dir, 'objects', second.slice(0, 2), second.slice(2));
  chmodSync(object, 0o644);
  writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`commit ${Buffer.byteLength(body)}\0`), Buffer.from(body)])));
  // git walks the forged history without complaint: the side commit is now "in" main.
  plainGit(['-C', dir, 'merge-base', '--is-ancestor', source.sideCommit, 'refs/heads/main']);
  assert.equal(onBranch(url, 'main', source.sideCommit, cache), false, 'the forged clone was used');
  assert.equal(onBranch(url, 'main', source.commit, cache), true);
});

test('the git cache is a private directory of the user, outside the registry', async () => {
  const saved = process.env.XDG_CACHE_HOME;
  try {
    process.env.XDG_CACHE_HOME = join(scratch, 'xdg');
    assert.equal(defaultCacheDir(), join(scratch, 'xdg', 'meaninggraph-registry'));
    assert.equal(dirname(cacheDirFor(root)), defaultCacheDir());
    for (const unset of ['relative/cache', '']) {
      process.env.XDG_CACHE_HOME = unset;
      assert.equal(dirname(defaultCacheDir()), join(tmpdir()));
      assert.match(basename(defaultCacheDir()), /^meaninggraph-registry-\w+/);
    }
  } finally {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved;
  }
  assert.ok(!cacheDirFor(root).startsWith(`${root}${sep}`), 'the cache is outside this repository');
  const dir = registry();
  assert.notEqual(cacheDirFor(dir), cacheDirFor(root), 'each registry directory has its own cache');
  const refused = async (cache, pattern) => {
    const result = await checkRegistry({ root: dir, urlFor, cacheDir: cache });
    assert.equal(result.problems.length, 1);
    assert.match(result.problems[0], pattern);
    assert.equal(result.checker, undefined, 'nothing was fetched or checked');
  };
  await refused(join(dir, '.cache'), /^cache: .* is inside the registry .*; the git cache is kept outside it/);
  await refused(dir, /^cache: .* is inside the registry /);
  const open = join(scratch, `open-${count++}`);
  mkdirSync(open);
  chmodSync(open, 0o777);
  await refused(open, /^cache: .* can be written by other users; the git cache is not kept there/);
  const link = join(scratch, `link-${count++}`);
  symlinkSync(mkdtempSync(join(scratch, 'target-')), link);
  await refused(link, /^cache: .* is not a directory of its own \(a symbolic link is not followed\)/);
  // One of its parts behind a symbolic link is refused too.
  const parts = join(scratch, `parts-${count++}`);
  mkdirSync(parts);
  symlinkSync(mkdtempSync(join(scratch, 'target-')), join(parts, 'history'));
  await refused(parts, /^cache: .*history is not a directory of its own/);
});
