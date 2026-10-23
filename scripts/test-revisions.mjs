import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {artifactPath, publishCatalog, resolveRevision, retainRevision, revisionId, sha256, validateSelections} from './lib/revisions.mjs';

const address = 'modelspec://github.com/test/chinook/chinook';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const sourceBytes=Buffer.from('original registry record\n');
const nativeDefinition=commit=>Buffer.from(JSON.stringify({format:'meaninggraph-definition/draft-1',kind:'model',revision_id:revisionId('model',address,commit),ast:{modelspec:'1.0-draft-2',module:{id:'github.com/test/chinook',version:'0.1.0'},records:{}}}));
const revision = (commit, path, bytes) => ({
  format: 'meaninggraph-revision/draft-1', id: revisionId('model', address, commit), kind: 'model', address, commit,
  repository: 'https://github.com/test/chinook', registry_id: 'chinook', dependency_pins: [],
  maintainers:['test'],licences:{model:'MIT'},format_identifier:'1.0-draft-2',module:{id:'github.com/test/chinook',name:'chinook',version:'0.1.0'},
  logical_digest:{algorithm:'meaninggraph-logical-digest/v1',sha256:'c'.repeat(64)},
  source_record:{repository:'https://github.com/modelspec-org/registry',commit:A,path:'models/$records/chinook.yaml',sha256:sha256(sourceBytes),artifactPath:artifactPath(sha256(sourceBytes))},
  definition:{path:`definitions/${revisionId('model',address,commit)}.json`,sha256:sha256(nativeDefinition(commit))},
  files: [{path, mediaType: 'application/json', sha256: sha256(bytes), artifactPath: artifactPath(sha256(bytes))}],
});

test('A remains available offline after B selection and source path rename; repeat import is a no-op', async t => {
  const root=await mkdtemp(join(tmpdir(),'mg-revisions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const a=Buffer.from('{"original":"A"}\n'), b=Buffer.from('{"original":"B"}\n');
  await retainRevision(root,revision(A,'old.modelspec.json',a),new Map([['old.modelspec.json',a]]),sourceBytes,nativeDefinition(A));
  await retainRevision(root,revision(A,'old.modelspec.json',a),new Map([['old.modelspec.json',a]]),sourceBytes,nativeDefinition(A));
  const entry={id:'chinook',address,repository:'https://github.com/test/chinook',commit:A};
  await publishCatalog(root,{models:[entry],graphs:[]});
  await retainRevision(root,revision(B,'model/new.modelspec.json',b),new Map([['model/new.modelspec.json',b]]),sourceBytes,nativeDefinition(B));
  await publishCatalog(root,{models:[{...entry,commit:B}],graphs:[]});
  const exact=await resolveRevision(root,{kind:'model',address,commit:A});
  assert.equal(exact.exact_commit,A);assert.deepEqual(exact.original_paths,['old.modelspec.json']);assert.deepEqual(exact.artifacts.get('old.modelspec.json'),a);
  const selected=JSON.parse(await readFile(join(root,'catalog.json'),'utf8'));assert.equal(selected.models[0].commit,B);
});

test('tampering and missing history never fall back to current selection',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mg-revisions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('A');const r=revision(A,'a.json',bytes);
  await retainRevision(root,r,new Map([['a.json',bytes]]),sourceBytes,nativeDefinition(A));
  await writeFile(join(root,r.files[0].artifactPath),'tampered');
  assert.equal((await resolveRevision(root,{kind:'model',address,commit:A})).error,'digest-mismatch');
  assert.equal((await resolveRevision(root,{kind:'model',address,commit:B})).error,'unknown-revision');
  await assert.rejects(retainRevision(root,r,new Map([['a.json',bytes]]),sourceBytes,nativeDefinition(A)),/immutable conflict/);
});

test('current snapshot rejects conflicting repository pins and duplicate identities',()=>{
  const a={kind:'model',address,repository:'https://github.com/test/chinook',commit:A};
  const b={kind:'meaning',address:'meaning://github.com/test/chinook',repository:a.repository,commit:B};
  assert.throws(()=>validateSelections([a,b]),new RegExp(`${A} and ${B}`));
  assert.throws(()=>validateSelections([a,a]),/duplicate selected identity/);
  assert.equal(validateSelections([a,{...b,commit:A}])[a.repository],A);
});

test('meaning-only and empty catalogs require no model or semantic checker',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mg-revisions-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await publishCatalog(root,{models:[],graphs:[]});
  assert.deepEqual(JSON.parse(await readFile(join(root,'catalog.json'),'utf8')).models,[]);
});
