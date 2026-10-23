// Validate both resource families through the native builder into a private
// disposable staging tree. No output is installed or activated.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildCatalog,buildModelChecker} from './lib/catalog.mjs';

const root=process.argv[2]??dirname(dirname(fileURLToPath(import.meta.url)));
const scratch=await mkdtemp(join(tmpdir(),'meaninggraph-check-'));
let modelChecker;
try {
  modelChecker=await buildModelChecker(root);
  const checked=await buildCatalog({root,output:join(scratch,'catalog'),modelChecker});
  console.log(`ok: ${checked.models.length} DataModels, ${checked.graphs.length} meaning graphs, ${checked.revisions.length} revisions; committed input snapshot verified`);
}catch(error){console.error(`error: ${error.message}`);process.exitCode=1;}
finally {
  await rm(scratch,{recursive:true,force:true});
  if(modelChecker)await rm(dirname(modelChecker),{recursive:true,force:true});
}
