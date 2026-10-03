// Tests that inGitDB itself rejects broken records (CC0-1.0): each case copies
// the registry, breaks one constraint of a collection definition, and expects
// `ingitdb validate` to exit 2. INGITDB_CLI names the binary (CI installs the
// release the workflow pins); the tests fail, rather than skip, without it.
//
//   INGITDB_CLI=/path/to/ingitdb node --test scripts/test-ingitdb.mjs
//
// The URL forms of `address` and `repository` are not here: inGitDB does not
// validate a column's `format`, so scripts/check.mjs checks them (scripts/test.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.INGITDB_CLI;
const scratch = mkdtempSync(join(tmpdir(), 'registry-ingitdb-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

const record = (dir, collection, key) => join(dir, collection, '$records', `${key}.yaml`);
const edit = (collection, key, change) => (dir) => {
  const path = record(dir, collection, key);
  const data = parseYaml(readFileSync(path, 'utf8'));
  change(data);
  writeFileSync(path, stringifyYaml(data));
};

function validate(change) {
  const dir = join(scratch, `db-${count++}`);
  mkdirSync(dir);
  for (const name of ['.ingitdb', 'graphs', 'dependencies', 'maintainers']) cpSync(join(root, name), join(dir, name), { recursive: true });
  change?.(dir);
  try {
    execFileSync(cli, ['validate', `--path=${dir}`, '--safe-diagnostics'], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('INGITDB_CLI names the inGitDB binary', () => {
  assert.ok(cli, 'set INGITDB_CLI to the ingitdb binary');
  assert.match(execFileSync(cli, ['version']).toString(), /\d+\.\d+\.\d+/);
});

test('the registry as committed is a valid inGitDB database', () => {
  assert.equal(validate(), 0);
});

const cases = {
  'graphs: title missing (required)': edit('graphs', 'core', (x) => { delete x.title; }),
  'graphs: description missing (required)': edit('graphs', 'core', (x) => { delete x.description; }),
  'graphs: kind outside its enum': edit('graphs', 'core', (x) => { x.kind = 'other'; }),
  'graphs: status outside its enum': edit('graphs', 'core', (x) => { x.status = 'live'; }),
  'graphs: format outside its enum': edit('graphs', 'core', (x) => { x.format = 'x'; }),
  'graphs: commit of 39 characters (length)': edit('graphs', 'core', (x) => { x.commit = x.commit.slice(1); }),
  'graphs: commit of 41 characters (length)': edit('graphs', 'core', (x) => { x.commit += 'a'; }),
  'graphs: empty title (min_length)': edit('graphs', 'core', (x) => { x.title = ''; }),
  'graphs: title of 121 characters (max_length)': edit('graphs', 'core', (x) => { x.title = 'a'.repeat(121); }),
  'graphs: title that is a number (type)': edit('graphs', 'core', (x) => { x.title = 123; }),
  'graphs: tag that is a number (type)': edit('graphs', 'core', (x) => { x.tag = 5; }),
  'graphs: empty meaning_files (min_length)': edit('graphs', 'core', (x) => { x.meaning_files = []; }),
  'graphs: meaning_files that is a string (type)': edit('graphs', 'core', (x) => { x.meaning_files = 'a.meaning.yaml'; }),
  'graphs: meaning_files item that is a number (type)': edit('graphs', 'core', (x) => { x.meaning_files = [1]; }),
  'graphs: model_files without model_licence (required_when)': edit('graphs', 'chinook', (x) => { delete x.model_licence; }),
  'graphs: empty model_files (min_length)': edit('graphs', 'chinook', (x) => { x.model_files = []; }),
  'graphs: unknown maintainer (foreign_key)': edit('graphs', 'core', (x) => { x.maintainers = ['nobody']; }),
  'graphs: unknown second maintainer (foreign_key on a list)': edit('graphs', 'core', (x) => { x.maintainers = ['trakhimenok', 'nobody']; }),
  'graphs: empty maintainers (min_length)': edit('graphs', 'core', (x) => { x.maintainers = []; }),
  'graphs: maintainers missing (required)': edit('graphs', 'core', (x) => { delete x.maintainers; }),
  'graphs: unknown column': edit('graphs', 'core', (x) => { x.colour = 'blue'; }),
  'dependencies: unknown depends_on (foreign_key)': edit('dependencies', 'chinook--core', (x) => { x.depends_on = 'nobody'; }),
  'dependencies: unknown graph (foreign_key)': edit('dependencies', 'chinook--core', (x) => { x.graph = 'nobody'; }),
  'dependencies: commit of 39 characters (length)': edit('dependencies', 'chinook--core', (x) => { x.commit = x.commit.slice(1); }),
  'dependencies: commit missing (required)': edit('dependencies', 'chinook--core', (x) => { delete x.commit; }),
  'dependencies: unknown column': edit('dependencies', 'chinook--core', (x) => { x.extra = 1; }),
  'maintainers: name missing (required)': edit('maintainers', 'trakhimenok', (x) => { delete x.name; x.nick = 'a'; }),
  'maintainers: empty name (min_length)': edit('maintainers', 'trakhimenok', (x) => { x.name = ''; }),
};

for (const [name, change] of Object.entries(cases)) {
  test(`inGitDB rejects ${name}`, () => {
    assert.equal(validate(change), 2, 'ingitdb validate exits 2 on invalid data');
  });
}
