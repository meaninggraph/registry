// Checks the registry, CC0-1.0 like everything else here.
//
//   node scripts/check.mjs [registry directory]   (default: this repository)
//
// Run after `ingitdb validate` (structure, types, required columns, enums,
// foreign keys). This adds the meaning checks: ids and commit ids are well
// formed, every address is the meaning:// form of its repository and is
// registered once, index.json matches the records, and each graph, fetched at
// its commit, has the files the entry lists, passes the meaning checker of
// meaninggraph/core (taken at the commit of the `core` record), declares the
// licences the entry states, and pins exactly the dependencies the entry lists.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRegistry } from './lib/registry.mjs';

const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
const { problems, graphs, checker } = await checkRegistry({ root });
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  console.error(`${problems.length} problem${problems.length === 1 ? '' : 's'} in ${graphs} graph${graphs === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`ok: ${graphs} graphs checked with the meaning checker of meaninggraph/core at ${checker}`);
