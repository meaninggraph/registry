import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildIndex, checkRegistry, loadChecker, readRegistry} from './lib/registry.mjs';

const source=dirname(dirname(fileURLToPath(import.meta.url)));
test('nonempty model collection checks without a core graph or any semantic fetch',async t=>{
  const root=mkdtempSync(join(tmpdir(),'mg-model-only-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const path of ['.ingitdb','graphs','models','dependencies','maintainers']) cpSync(join(source,path),join(root,path),{recursive:true});
  for(const path of ['graphs/$records','dependencies/$records']) {rmSync(join(root,path),{recursive:true});mkdirSync(join(root,path));}
  writeFileSync(join(root,'index.json'),buildIndex(readRegistry(root)));
  assert.equal(readRegistry(root).models.length,9);
  const result=await checkRegistry({root,urlFor:()=>{throw new Error('must not fetch semantic code');}});
  assert.deepEqual(result.problems,[]);assert.equal(result.graphs,0);assert.equal(result.checker,undefined);
});

test('independent tooling pin cannot nominate an arbitrary checker repository',async t=>{
  const root=mkdtempSync(join(tmpdir(),'mg-trusted-checker-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'tools.json'),JSON.stringify({format:'meaninggraph-tools/v1',meaning:{repository:'https://github.com/attacker/code',commit:'a'.repeat(40),entrypoint:'scripts/lib/meaning.mjs'}}));
  await assert.rejects(loadChecker({root,graphs:[],urlFor:()=>{throw new Error('unapproved code must not be fetched');}}),/where the checker lives/);
});
