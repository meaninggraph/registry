// Build and reconcile into a separate staging directory. This never changes
// source registrations, removes history, activates a writer or publishes data.
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildCatalog, buildModelChecker} from './lib/catalog.mjs';

const originalArgs=process.argv.slice(2);
const allowWorkingTree=originalArgs.includes('--allow-working-tree');
const args=originalArgs.filter(arg=>arg!=='--allow-working-tree');
if(args.length!==2||args[0]!=='--output') {
  console.error('usage: node scripts/build-catalog.mjs --output <new-staging-directory> [--allow-working-tree]');
  process.exitCode=2;
} else {
  const root=dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    const modelChecker=await buildModelChecker(root);
    const result=await buildCatalog({root,output:resolve(args[1]),modelChecker,allowWorkingTree});
    console.log(`Validated ${result.models.length} DataModels, ${result.graphs.length} meaning graphs and ${result.revisions.length} retained revisions.`);
    console.log(`Activation eligible: ${result.report.activation_eligible}; input snapshot: ${result.report.registry_snapshot.mode}`);
    console.log(`Staged catalog and reconciliation report: ${resolve(args[1])}`);
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
