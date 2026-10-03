// Tests for the registry checks (CC0-1.0). Each test copies the registry into a
// temporary directory, breaks one thing, and expects the check to name it.
// The checker and the registered graphs are fetched from GitHub at their
// commits (cached in .cache); a graph whose files must be broken is a local git
// repository that stands in for an https URL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildIndex, checkRegistry, checkerRepository, declaredLicence, defaultBranch, fetchCommit, loadChecker, readRegistry, repositoryHosts, setGitProtocols } from './lib/registry.mjs';

// The local repositories that stand in for https URLs are file:// URLs, at
// https://example.test/fixtures/<name>; the tests allow that host.
setGitProtocols('https:file');
repositoryHosts.set('example.test', 2);

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
function origin(name, files, { from, side, symlinks = {}, branches = [], tags = [], repository = `https://example.test/fixtures/${name}` } = {}) {
  const dir = join(scratch, `origin-${count++}`);
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();
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
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: model_licence is Apache-2\.0, but model\/chinook\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);
});

test('the same graph registered under a second id fails', async () => {
  const dir = registry((d) => writeRecord(d, 'graphs', 'chinook-again', readRecord(d, 'graphs', 'chinook')));
  const { problems } = await check(dir);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: address meaning:\/\/github\.com\/datatug\/chinookdb is registered under 2 ids \(chinook-again: meaning:\/\/github\.com\/datatug\/chinookdb, chinook: meaning:\/\/github\.com\/datatug\/chinookdb, compared ignoring case\); a graph is registered once$/);
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
    writeRecord(d, 'graphs', 'chinook-dup', { ...readRecord(d, 'graphs', 'chinook'), repository: 'https://github.com/datatug/chinookdb.git', address: 'meaning://github.com/datatug/chinookdb.git' });
    writeRecord(d, 'dependencies', 'chinook-dup--core', { ...readRecord(d, 'dependencies', 'chinook--core'), graph: 'chinook-dup' });
  });
  expectProblem((await check(dotGit)).problems, /^graphs\/\$records\/chinook-dup\.yaml: repository must be an https URL of a repository on github\.com, example\.test, such as https:\/\/github\.com\/\{org\}\/\{repo\} \(no trailing slash, \.git, "\." or "\.\." segments\)/);
  const cased = registry((d) => {
    writeRecord(d, 'graphs', 'chinook-dup', { ...readRecord(d, 'graphs', 'chinook'), repository: 'https://github.com/Datatug/ChinookDB', address: 'meaning://github.com/Datatug/ChinookDB' });
    writeRecord(d, 'dependencies', 'chinook-dup--core', { ...readRecord(d, 'dependencies', 'chinook--core'), graph: 'chinook-dup' });
  });
  const { problems } = await check(cased);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: repository https:\/\/github\.com\/datatug\/chinookdb is registered under 2 ids \(chinook-dup: https:\/\/github\.com\/Datatug\/ChinookDB, chinook: https:\/\/github\.com\/datatug\/chinookdb, compared ignoring case\)/);
  expectProblem(problems, /^graphs\/\$records\/chinook\.yaml: address meaning:\/\/github\.com\/datatug\/chinookdb is registered under 2 ids/);
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
  const withDefault = origin('licence-default', { 'fixture.meaning.yaml': meaningFile(), 'm.modelspec.json': '{}', LICENSE: 'MIT License\n', 'LICENSE-CC0': CC0 });
  const wrong = registry((d) => writeRecord(d, 'graphs', 'licence-default', fixtureRecord(withDefault, { model_files: ['m.modelspec.json'], model_licence: 'CC0-1.0' })));
  expectProblem((await check(wrong)).problems, /^graphs\/\$records\/licence-default\.yaml: model_licence is CC0-1\.0, but m\.modelspec\.json declares no licence and the repository's default licence \(its LICENSE file\) is MIT/);
  const right = registry((d) => writeRecord(d, 'graphs', 'licence-default', fixtureRecord(withDefault, { model_files: ['m.modelspec.json'], model_licence: 'MIT' })));
  assert.deepEqual((await check(right)).problems, []);
  const noDefault = origin('licence-several', { 'fixture.meaning.yaml': meaningFile(), 'm.modelspec.json': '{}', 'LICENSE-MIT': 'MIT License\n', 'LICENSE-CC0': CC0 });
  const ambiguous = registry((d) => writeRecord(d, 'graphs', 'licence-several', fixtureRecord(noDefault, { model_files: ['m.modelspec.json'], model_licence: 'MIT' })));
  expectProblem((await check(ambiguous)).problems, /^graphs\/\$records\/licence-several\.yaml: m\.modelspec\.json declares no licence, and the repository's LICENSE files name several \((MIT, CC0-1\.0|CC0-1\.0, MIT)\); the file must declare its licence/);
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
  expectProblem((await check(missing)).problems, /^graphs\/\$records\/chinook\.yaml: meaning_files: model\/missing\.meaning\.yaml does not exist at commit 6f1bac9/);
  const stray = registry((d) => writeFileSync(join(d, 'graphs', '$records', 'stray.yml'), 'x: 1\n'));
  expectProblem((await check(stray)).problems, /^graphs\/\$records\/stray\.yml: a record is a <key>\.yaml file/);
  const paths = registry((d) => writeRecord(d, 'graphs', 'core', { ...readRecord(d, 'graphs', 'core'), meaning_files: ['../x.meaning.yaml', 'README.md'], model_files: ['a.hcl'], model_licence: 'MIT' }));
  const { problems } = await check(paths);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: meaning_files: "\.\.\/x\.meaning\.yaml" must be a relative path inside the repository/);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: meaning_files: "README\.md" must name \*\.meaning\.yaml files/);
  expectProblem(problems, /^graphs\/\$records\/core\.yaml: a universal graph has no model files/);
});

test('index.json is sorted by code unit, whatever the locale', () => {
  const ids = ['ya', 'ia', 'a0', 'ab', 'a-b', 'aa'];
  const index = JSON.parse(buildIndex({ graphs: ids.map((key) => ({ key, data: {} })), dependencies: [] }));
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
  assert.deepEqual(index.graphs.map((graph) => graph.id), ['chinook', 'core']);
  assert.deepEqual(index.graphs[0].depends, [{ id: 'core', commit: 'cb97dbcd9e951b00e7d46cb2e0c4e120c24c8db7' }]);
});

test('a file declares its licence in its first lines or in a meaning file field', () => {
  assert.equal(declaredLicence('a.meaning.yaml', '', { license: 'CC0-1.0' }), 'CC0-1.0');
  assert.equal(declaredLicence('m.hcl', '# Licence: MIT (https://example.test/LICENSE).\n', null), 'MIT');
  assert.equal(declaredLicence('m.go', '// SPDX-License-Identifier: Apache-2.0\n', null), 'Apache-2.0');
  assert.equal(declaredLicence('m.json', '{"modelspec": "1.0-draft"}', null), null);
});
