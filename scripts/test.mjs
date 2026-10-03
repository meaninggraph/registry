// Tests for the registry checks (CC0-1.0). Each test copies the registry into a
// temporary directory, breaks one thing, and expects the check to name it.
// The checker and the registered graphs are fetched from GitHub at their
// commits (cached in .cache); a graph whose files must be broken is a local git
// repository that stands in for an https URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildIndex, checkRegistry, checkerRepository, declaredLicence, fetchCommit, loadChecker, readRegistry } from './lib/registry.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, '.cache');
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
function origin(name, files, { from, side, repository = `https://example.test/fixtures/${name}` } = {}) {
  const dir = join(scratch, `origin-${count++}`);
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
  const commitFiles = (entries) => {
    for (const [path, text] of Object.entries(entries)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git('add', '.');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'files');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  if (from) cpSync(from, dir, { recursive: true, filter: (path) => !/\/(\.git|node_modules)(\/|$)/.test(path.slice(from.length)) });
  const commit = commitFiles(files);
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
const expectProblem = (problems, pattern) => assert.ok(problems.some((problem) => pattern.test(problem)), `expected a problem matching ${pattern}, got:\n${problems.join('\n') || '(none)'}`);

test('the registry as committed passes every check', async () => {
  const { problems, graphs } = await check(root);
  assert.deepEqual(problems, []);
  assert.equal(graphs, 2);
});

test('an unknown commit fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), commit: '0c34c1a3e0616fa53810916503b3bf3c8a925800' }));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: cannot fetch 0c34c1a3e0616fa53810916503b3bf3c8a925800 from https:\/\/github\.com\/datatug\/chinookdb: .*not our ref/);
});

test('a path that does not exist at the commit fails', async () => {
  const dir = registry((d) => {
    const chinook = readRecord(d, 'graphs', 'chinook');
    writeRecord(d, 'graphs', 'chinook', { ...chinook, model_files: [...chinook.model_files, 'model/missing.modelspec.hcl'] });
  });
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: model_files: model\/missing\.modelspec\.hcl does not exist at commit 6f1bac9/);
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
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: model_licence is Apache-2\.0, but model\/chinook\.modelspec\.json declares no licence and the repository's LICENSE files name (MIT, CC0-1\.0|CC0-1\.0, MIT)/);
});

test('the same graph registered under a second id fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook-again', readRecord(d, 'graphs', 'chinook')));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: address meaning:\/\/github\.com\/datatug\/chinookdb is registered under 2 ids \(chinook-again, chinook\); a graph is registered once$/);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: repository https:\/\/github\.com\/datatug\/chinookdb is registered under 2 ids/);
});

test('an id that the record contract would reject fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'Core_2', { ...readRecord(d, 'graphs', 'core'), address: 'meaning://github.com/meaninggraph/other', repository: 'https://github.com/meaninggraph/other' }));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/Core_2\.yaml: id "Core_2" must be lower-case letters, digits and single hyphens/);
});

test('an address that is not the meaning:// form of the repository fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), address: 'meaning://github.com/datatug/chinook' }));
  expectProblem((await check(dir)).problems, /^graphs\/\$records\/chinook\.yaml: address must be meaning:\/\/github\.com\/datatug\/chinookdb/);
});

test('a dependency pinned at another commit than the files pin fails', async () => {
  const dir = registry((d) => writeRecord(d, 'dependencies', 'chinook--core', { ...readRecord(d, 'dependencies', 'chinook--core'), commit: '4214bc73cbfcc706c0ea9c8873eba991d9ddbb91' }));
  expectProblem((await check(dir)).problems, /^dependencies\/\$records\/chinook--core\.yaml: commit is 4214bc73cbfcc706c0ea9c8873eba991d9ddbb91, but the meaning files of chinook pin meaning:\/\/github\.com\/meaninggraph\/core at cb97dbcd9e951b00e7d46cb2e0c4e120c24c8db7/);
});

test('a dependency that the files do not declare fails, and so does one they do not use', async () => {
  const missing = registry((d) => rmSync(record(d, 'dependencies', 'chinook--core')));
  expectProblem((await check(missing)).problems, /^graphs\/\$records\/chinook\.yaml: the meaning files reference meaning:\/\/github\.com\/meaninggraph\/core \(pinned cb97dbc[0-9a-f]+\); add dependencies\/\$records\/chinook--core\.yaml/);
  const unused = registry((d) => writeRecord(d, 'dependencies', 'core--chinook', { graph: 'core', depends_on: 'chinook', commit: '6f1bac962bccadeaa3f85e19454486ad79544ad4' }));
  expectProblem((await check(unused)).problems, /^dependencies\/\$records\/core--chinook\.yaml: core does not reference chinook at commit cb97dbc[0-9a-f]+; remove the dependency/);
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

test('index.json that differs from the records fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook', { ...readRecord(d, 'graphs', 'chinook'), title: 'Chinook' }), { rebuildIndex: false });
  expectProblem((await check(dir)).problems, /^index\.json differs from the records; run npm run index and commit it$/);
});

test('index.json carries a checksum of its graphs array', () => {
  const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
  const sha = execFileSync('shasum', ['-a', '256'], { input: JSON.stringify(index.graphs) }).toString().split(' ')[0];
  assert.equal(index.checksum, `sha256:${sha}`);
  assert.deepEqual(index.graphs.map((graph) => graph.id), ['chinook', 'core']);
  assert.deepEqual(index.graphs[0].depends, [{ id: 'core', commit: 'cb97dbcd9e951b00e7d46cb2e0c4e120c24c8db7' }]);
});

test('a file declares its licence in its first lines or in a meaning file field', () => {
  assert.equal(declaredLicence('a.meaning.yaml', '', { license: 'CC0-1.0' }), 'CC0-1.0');
  assert.equal(declaredLicence('m.hcl', '# Licence: MIT (https://example.test/LICENSE).\n', null), 'MIT');
  assert.equal(declaredLicence('m.go', '// SPDX-License-Identifier: Apache-2.0\n', null), 'Apache-2.0');
  assert.equal(declaredLicence('m.json', '{"modelspec": "1.0-draft"}', null), null);
});
