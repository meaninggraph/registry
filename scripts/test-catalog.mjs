import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildIndex,readRegistry,setGitProtocols} from './lib/registry.mjs';
import {buildCatalog, buildModelChecker, pinnedSource, registryInputSnapshot} from './lib/catalog.mjs';
import {CATALOG_FORMAT,artifactPath,revisionId,sha256,resolveRevision,selectRevision,validateSelections} from './lib/revisions.mjs';
import {auditHistoryBaseline} from './lib/catalog.mjs';
setGitProtocols('https:file');
const source=process.env.MG_FIXTURE_SOURCE??dirname(dirname(fileURLToPath(import.meta.url)));
const A='3e7bb316d8a438eb7e5930067997a4e4543a275c', B='b'.repeat(40), C='c'.repeat(40);
const hcl=name=>`# SPDX-License-Identifier: MIT\nrecord "${name}" {}\n`;
const modelJSON=(repository,module,{large=false}={})=>JSON.stringify({modelspec:'1.0-draft-2',module:{id:`${repository.slice('https://'.length)}/${module}`,name:module,version:'0.1.0'},records:{[module]:{fields:{n:{type:'integer',...(large?{minimum:9007199254740993n.toString()}: {})}}}}}).replace(/"minimum":"(\d+)"/,'"minimum":$1')+'\n';
function setup(t) {
 const root=mkdtempSync(join(tmpdir(),'mg-catalog-fixture-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const p of ['.ingitdb','models/.collection','models/$records','maintainers/.collection','maintainers/$records','graphs/.collection','graphs/$records','dependencies/.collection','dependencies/$records','model_dependencies/.collection','model_dependencies/$records','revisions/.collection','revisions/$records']) {const from=join(source,p);if(p.includes('.collection'))cpSync(from,join(root,p),{recursive:true});else mkdirSync(join(root,p),{recursive:true});}
 const chinook=readFileSync(join(source,'models/$records/chinook.yaml'),'utf8');writeFileSync(join(root,'models/$records/chinook.yaml'),chinook);
 cpSync(join(source,'maintainers/$records/trakhimenok.yaml'),join(root,'maintainers/$records/trakhimenok.yaml'));
 for(const p of ['graphs','dependencies','model_dependencies','revisions'])cpSync(join(source,p,'.collection'),join(root,p,'.collection'),{recursive:true});
 writeFileSync(join(root,'.ingitdb/root-collections.yaml'),readFileSync(join(source,'.ingitdb/root-collections.yaml')));
 writeFileSync(join(root,'index.json'),buildIndex(readRegistry(root)));
 execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','fixture'],{cwd:root});
 const sourceFor=async(repository,commit)=>{if(repository==='https://github.com/modelspec-org/registry'){const bytes=readFileSync(join(source,'models/$records/chinook.yaml'));return {files:['models/$records/chinook.yaml'],read:path=>path==='models/$records/chinook.yaml'?bytes:Buffer.from('')}}const module=repository.split('/').at(-1);const json=modelJSON(repository,module,{large:repository.endsWith('/chinook')});return {files:[`model/${module}.modelspec.hcl`,`model/${module}.modelspec.json`,'LICENSE','COPYING'],read:path=>Buffer.from(path.endsWith('.hcl')?hcl(module):path==='LICENSE'||path==='COPYING'?'The MIT License (MIT)\nCopyright Test\n':json)}};
 const checkModels=({modules})=>({ok:true,logical_digest:`sha256:${'a'.repeat(64)}`,ast:JSON.parse(modules[0].json),ast_json:modules[0].json});
 return {root,output:join(root,'out'),chinook,sourceFor,checkModels};
}
function reindex(root){writeFileSync(join(root,'index.json'),buildIndex(readRegistry(root)));}
function copyHistory(from,to){for(const top of ['artifacts','definitions','revisions'])cpSync(join(from,top),join(to,top),{recursive:true,force:true});}
function otherRecord(base,commit){return base.replace('Chinook music store','Other music model').replace('modelspec://github.com/demo-db/chinook/chinook','modelspec://github.com/demo-db/other/other').replace('https://github.com/demo-db/chinook','https://github.com/demo-db/other').replace(`commit: ${A}`,`commit: ${commit}`).replace('module: chinook','module: other').replace('model/chinook.modelspec.hcl','model/other.modelspec.hcl').replace('model/chinook.modelspec.json','model/other.modelspec.json');}
function addLock(root,{commit,targetCommit}){writeFileSync(join(root,'model_dependencies/$records/chinook--other.yaml'),`model: chinook\ncommit: ${commit}\nalias: other\ntarget_model: other\ntarget_commit: ${targetCommit}\n`);}

test('model-only catalog builds independently and preserves exact legacy model entry contract',async t=>{
 const f=setup(t);const result=await buildCatalog({...f,fixture:true,checkMeanings:false});assert.equal(result.models.length,1);assert.deepEqual(result.graphs,[]);
 const legacy=JSON.parse(readFileSync(join(f.output,'modelspec-index.json'),'utf8')).models[0];assert.deepEqual(Object.keys(legacy),['id','title','description','status','homepage','address','repository','commit','module','module_id','module_version','modelspec','licence','files','maintainers','records','components']);
});

test('retained A source bytes, large-number AST and revision index survive selection of B',async t=>{
 const f=setup(t);const sourceBytes=readFileSync(join(f.root,'models/$records/chinook.yaml'));const aOut=join(f.root,'stage-A');await buildCatalog({...f,output:aOut,fixture:true,checkMeanings:false});copyHistory(aOut,f.root);
 const rec=join(f.root,'models/$records/chinook.yaml');writeFileSync(rec,readFileSync(rec,'utf8').replace(A,B));reindex(f.root);f.output=join(f.root,'stage-B');await buildCatalog({...f,fixture:true,checkMeanings:false});
 const id=revisionId('model','modelspec://github.com/demo-db/chinook/chinook',A),definition=readFileSync(join(f.output,'definitions',`${id}.json`),'utf8');assert.match(definition,/9007199254740993/);
 assert.equal(readFileSync(join(f.output,'artifacts/sha256',sha256(sourceBytes).slice(0,2),sha256(sourceBytes)),'utf8'),sourceBytes.toString());
 assert.ok(JSON.parse(readFileSync(join(f.output,'revisions/index.json'),'utf8')).revisions.some(row=>row.id===id));
 assert.equal((await resolveRevision(f.output,{kind:'model',address:'modelspec://github.com/demo-db/chinook/chinook',commit:A})).exact_commit,A);
 assert.equal(JSON.parse(readFileSync(join(f.output,'catalog.json'),'utf8')).models[0].commit,B);
});

test('Chinook B resolves registered other module at historical A while other is selected at C',async t=>{
 const f=setup(t);rmSync(join(f.root,'models/$records/chinook.yaml'));writeFileSync(join(f.root,'models/$records/other.yaml'),otherRecord(f.chinook,A));reindex(f.root);
 const aOut=join(f.root,'stage-other-A');await buildCatalog({...f,output:aOut,fixture:true,checkMeanings:false});copyHistory(aOut,f.root);
 writeFileSync(join(f.root,'models/$records/chinook.yaml'),f.chinook.replace(`commit: ${A}`,`commit: ${B}`));writeFileSync(join(f.root,'models/$records/other.yaml'),otherRecord(f.chinook,C));addLock(f.root,{commit:B,targetCommit:A});reindex(f.root);
 f.output=join(f.root,'stage-current');const result=await buildCatalog({...f,fixture:true,checkMeanings:false});
 const otherId=revisionId('model','modelspec://github.com/demo-db/other/other',A),chinookRevision=result.revisions.find(r=>r.registry_id==='chinook');
 assert.deepEqual(chinookRevision.dependency_pins,[{alias:'other',revision_id:otherId}]);
 assert.equal((await resolveRevision(f.output,{kind:'model',address:'modelspec://github.com/demo-db/other/other',commit:A})).exact_commit,A);
});

test('missing other historical revision fails without substituting current C',async t=>{
 const f=setup(t);writeFileSync(join(f.root,'models/$records/other.yaml'),otherRecord(f.chinook,C));writeFileSync(join(f.root,'models/$records/chinook.yaml'),f.chinook.replace(`commit: ${A}`,`commit: ${B}`));addLock(f.root,{commit:B,targetCommit:A});reindex(f.root);
 await assert.rejects(buildCatalog({...f,fixture:true,checkMeanings:false}),/unresolved historical model dependency|incomplete historical/i);
});

test('same module version with a different logical digest is rejected',async t=>{
 const f=setup(t),aOut=join(f.root,'stage-A');await buildCatalog({...f,output:aOut,fixture:true,checkMeanings:false});copyHistory(aOut,f.root);
 const rec=join(f.root,'models/$records/chinook.yaml');writeFileSync(rec,readFileSync(rec,'utf8').replace(A,B));reindex(f.root);
 const changed=({...args})=>({ok:true,logical_digest:`sha256:${'b'.repeat(64)}`,ast:JSON.parse(args.modules[0].json),ast_json:args.modules[0].json});
 await assert.rejects(buildCatalog({...f,output:join(f.root,'stage-B'),fixture:true,checkMeanings:false,checkModels:changed}),/logical change without model version change/);
});

test('rebuild after unrelated registry commit reuses exact retained A receipt',async t=>{
 const f=setup(t),aOut=join(f.root,'stage-A');await buildCatalog({...f,output:aOut,fixture:true,checkMeanings:false});copyHistory(aOut,f.root);
 const id=revisionId('model','modelspec://github.com/demo-db/chinook/chinook',A),path=join(f.root,'revisions/$records',`${id}.yaml`),before=readFileSync(path);
 mkdirSync(join(f.root,'unrelated'),{recursive:true});writeFileSync(join(f.root,'unrelated/note.txt'),'unrelated\n');execFileSync('git',['add','unrelated/note.txt'],{cwd:f.root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','unrelated registry data'],{cwd:f.root});
 f.output=join(f.root,'stage-rebuild');await buildCatalog({...f,fixture:true,checkMeanings:false});
 assert.deepEqual(readFileSync(join(f.output,'revisions/$records',`${id}.yaml`)),before);
});

test('corrupt retained source-record blob blocks publication even when old revision is unselected',async t=>{
 const f=setup(t),aOut=join(f.root,'stage-A');await buildCatalog({...f,output:aOut,fixture:true,checkMeanings:false});copyHistory(aOut,f.root);
 const id=revisionId('model','modelspec://github.com/demo-db/chinook/chinook',A),revision=JSON.parse(readFileSync(join(f.root,'revisions/$records',`${id}.yaml`),'utf8'));
 const artifact=join(f.root,revision.source_record.artifactPath);writeFileSync(artifact,'corrupt retained source record\n');
 const rec=join(f.root,'models/$records/chinook.yaml');writeFileSync(rec,readFileSync(rec,'utf8').replace(A,B));reindex(f.root);
 await assert.rejects(buildCatalog({...f,output:join(f.root,'stage-B'),fixture:true,checkMeanings:false}),/digest-mismatch|incomplete|corrupt|tamper/i);
});


test('revision identities canonicalize repository owner casing and preserve module casing',()=>{
 const lower='modelspec://github.com/demo-db/chinook/Module';
 assert.equal(revisionId('model',lower,A),revisionId('model','modelspec://github.com/DEMO-DB/Chinook/Module',A));
 assert.notEqual(revisionId('model',lower,A),revisionId('model','modelspec://github.com/DEMO-DB/Chinook/module',A));
 const catalog={format:CATALOG_FORMAT,graphs:[],models:[{id:'upper',address:lower,repository:'https://github.com/demo-db/chinook',commit:A}]};
 assert.equal(selectRevision(catalog,'model','modelspec://github.com/DEMO-DB/CHINOOK/Module').commit,A);
 assert.equal(selectRevision(catalog,'model','modelspec://github.com/DEMO-DB/CHINOOK/module'),null);
 const repo='https://github.com/demo-db/chinook';
 assert.doesNotThrow(()=>validateSelections([{kind:'model',address:lower,repository:repo,commit:A},{kind:'model',address:'modelspec://github.com/demo-db/chinook/module',repository:repo,commit:A}]));
 assert.throws(()=>validateSelections([{kind:'model',address:lower,repository:'https://github.com/DEMO-DB/Chinook',commit:A},{kind:'meaning',address:'meaning://github.com/demo-db/chinook',repository:repo,commit:B}]),/conflicting selected commits/);
 assert.throws(()=>validateSelections([{kind:'model',address:lower,repository:repo,commit:A},{kind:'model',address:'modelspec://github.com/DEMO-DB/CHINOOK/Module',repository:repo,commit:A}]),/duplicate selected identity/);
});

test('existing and nested non-fixture outputs are rejected before building',async t=>{
 const f=setup(t);const existing=join(tmpdir(),`mg-existing-${process.pid}-${Date.now()}`);mkdirSync(existing);t.after(()=>rmSync(existing,{recursive:true,force:true}));
 await assert.rejects(buildCatalog({root:f.root,output:existing}),/already exists/);
 await assert.rejects(buildCatalog({root:f.root,output:join(f.root,'nested','out')}),/disjoint from registry source/);
 await assert.rejects(buildCatalog({root:f.root,output:join(f.root,'..staging','out')}),/disjoint from registry source/);
});

test('late build failure removes staging output without exposing destination',async t=>{
 const f=setup(t);f.output=join(f.root,'failed-output');
 const checkModels=()=>{throw new Error('deliberate late fixture failure');};
 await assert.rejects(buildCatalog({...f,fixture:true,checkMeanings:false,checkModels}),/deliberate late fixture failure/);
 assert.equal(existsSync(f.output),false);
});

test('COPYING licence text is retained byte-for-byte as a source artifact',async t=>{
 const f=setup(t);const result=await buildCatalog({...f,fixture:true,checkMeanings:false});
 const revision=result.revisions.find(row=>row.registry_id==='chinook'),file=revision.files.find(row=>row.path==='COPYING');
 assert.ok(file);assert.equal(readFileSync(join(f.output,file.artifactPath),'utf8'),'The MIT License (MIT)\nCopyright Test\n');
});

async function committedHistory(t){
 const f=setup(t),out=join(f.root,'stage-A');await buildCatalog({...f,output:out,fixture:true,checkMeanings:false});copyHistory(out,f.root);
 execFileSync('git',['add','artifacts','definitions','revisions'],{cwd:f.root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','publish model A'],{cwd:f.root});
 const baseline=execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim();
 execFileSync('git',['update-ref','refs/remotes/origin/main',baseline],{cwd:f.root});execFileSync('git',['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main'],{cwd:f.root});
 writeFileSync(join(f.root,'unrelated.txt'),'unrelated registry data\n');execFileSync('git',['add','unrelated.txt'],{cwd:f.root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','advance registry HEAD'],{cwd:f.root});
 return {f,baseline,id:revisionId('model','modelspec://github.com/demo-db/chinook/chinook',A)};
}

test('protected baseline audit rejects removal of an admitted revision and its index row',async t=>{
 const {f,baseline,id}=await committedHistory(t);
 rmSync(join(f.root,'revisions/$records',`${id}.yaml`));
 const indexPath=join(f.root,'revisions/index.json'),index=JSON.parse(readFileSync(indexPath,'utf8'));index.revisions=index.revisions.filter(row=>row.id!==id);writeFileSync(indexPath,JSON.stringify(index)+'\n');
 assert.throws(()=>auditHistoryBaseline(f.root,baseline),/published history removed or linked/);
});

test('protected baseline audit rejects a changed source blob even with matching edited metadata',async t=>{
 const {f,baseline,id}=await committedHistory(t),revisionPath=join(f.root,'revisions/$records',`${id}.yaml`),revision=JSON.parse(readFileSync(revisionPath,'utf8'));
 const oldPath=revision.source_record.artifactPath,bytes=Buffer.from('replaced source record\n'),digest=sha256(bytes);writeFileSync(join(f.root,oldPath),bytes);
 revision.source_record.sha256=digest;revision.source_record.artifactPath=artifactPath(digest);mkdirSync(dirname(join(f.root,revision.source_record.artifactPath)),{recursive:true});writeFileSync(join(f.root,revision.source_record.artifactPath),bytes);writeFileSync(revisionPath,JSON.stringify(revision)+'\n');
 assert.throws(()=>auditHistoryBaseline(f.root,baseline),/published history changed/);
});



test('clean committed registry inputs are activatable',t=>{
 const f=setup(t),snapshot=registryInputSnapshot(f.root);
 assert.equal(snapshot.mode,'committed');assert.equal(snapshot.activation_eligible,true);assert.equal(snapshot.commit,execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim());
});

function snapshotFixture(t){
 const f=setup(t);
 mkdirSync(join(f.root,'tools/modelcheck'),{recursive:true});mkdirSync(join(f.root,'imports'),{recursive:true});
 writeFileSync(join(f.root,'tools.json'),'{}\n');writeFileSync(join(f.root,'tools/modelcheck/checker.go'),'package checker\n');
 writeFileSync(join(f.root,'imports/manifest.json'),'{}\n');
 writeFileSync(join(f.root,'model_dependencies/$records/chinook--chinook.yaml'),`model: chinook\ncommit: ${A}\nalias: chinook\ntarget_model: chinook\ntarget_commit: ${A}\n`);
 execFileSync('git',['add','tools.json','tools','imports','model_dependencies'],{cwd:f.root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','commit scoped registry inputs'],{cwd:f.root});
 return f;
}
for(const [name,mutate] of [
 ['tracked registry record',root=>writeFileSync(join(root,'models/$records/chinook.yaml'),readFileSync(join(root,'models/$records/chinook.yaml'),'utf8')+'# edit\n')],
 ['untracked tool input',root=>writeFileSync(join(root,'tools/untracked.go'),'package main\n')],
 ['deleted tracked tool input',root=>unlinkSync(join(root,'tools/modelcheck/checker.go'))],
 ['changed ModelSpec import manifest',root=>writeFileSync(join(root,'imports/manifest.json'),'changed\n')],
 ['changed model dependency lockfile',root=>writeFileSync(join(root,'model_dependencies/$records/chinook--chinook.yaml'),readFileSync(join(root,'model_dependencies/$records/chinook--chinook.yaml'),'utf8').replace(A,B))],
]) test(`registry input snapshot marks ${name} as non-activatable`,t=>{
 const f=snapshotFixture(t);mutate(f.root);const snapshot=registryInputSnapshot(f.root);
 assert.equal(snapshot.mode,'working-copy');assert.equal(snapshot.activation_eligible,false);assert.equal(snapshot.commit,execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim());
});

function emptyRegistry(t){
 const f=setup(t);rmSync(join(f.root,'models/$records/chinook.yaml'));reindex(f.root);execFileSync('git',['add','-A'],{cwd:f.root});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','empty model registry'],{cwd:f.root});return f;
}
test('non-fixture build refuses dirty inputs by default and reports allow-working-tree as non-activatable',async t=>{
 const f=emptyRegistry(t),head=execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim();
 writeFileSync(join(f.root,'.ingitdb/root-collections.yaml'),readFileSync(join(f.root,'.ingitdb/root-collections.yaml'),'utf8')+'# local edit\n');
 const denied=join(tmpdir(),`mg-dirty-denied-${process.pid}-${Date.now()}`),allowed=join(tmpdir(),`mg-dirty-allowed-${process.pid}-${Date.now()}`);
 t.after(()=>{rmSync(denied,{recursive:true,force:true});rmSync(allowed,{recursive:true,force:true});});
 await assert.rejects(buildCatalog({root:f.root,output:denied,baselineCommit:head}),/registry inputs differ from committed snapshot/);
 assert.equal(existsSync(denied),false);
 const result=await buildCatalog({root:f.root,output:allowed,baselineCommit:head,allowWorkingTree:true});
 assert.equal(result.report.registry_snapshot.mode,'working-copy');assert.equal(result.report.activation_eligible,false);
});

test('ModelSpec source import path and digest are checked even in working-copy mode',async t=>{
 for(const [name,record] of [
  ['wrong path',{path:'models/$records/elsewhere.yaml',sha256:sha256(readFileSync(join(source,'models/$records/chinook.yaml')))}],
  ['wrong digest',{path:'models/$records/chinook.yaml',sha256:'0'.repeat(64)}],
 ]) {
  const f=setup(t),bytes=readFileSync(join(source,'models/$records/chinook.yaml'));
  mkdirSync(join(f.root,'imports'),{recursive:true});writeFileSync(join(f.root,'imports/modelspec-registry.json'),JSON.stringify({format:'meaninggraph-import-source/v1',repository:'https://github.com/modelspec-org/registry',commit:'6e954755ee79b758213911dc2d97687808ed0f84',records:{chinook:record}})+'\n');
  const output=join(f.root,`bad-import-${name.replaceAll(' ','-')}`);
  await assert.rejects(buildCatalog({...f,output,fixture:true,allowWorkingTree:true,checkMeanings:false}),/unverified original model registry record/);
  assert.equal(existsSync(output),false);
  assert.equal(bytes.length>0,true);
 }
});

// These two HCL/JSON pairs were exported with github.com/modelspec-org/cli/pkg/modelspec v0.3.0.
const mixedHcl = {
 root: `component "Billing" {
  field "address" { component = "common.Address" }
}
record "Order" {
  use = ["common.Identified"]
  field "customer" { record = "common.Customer" }
  field "billing" { component = "Billing" }
  field "status" {
    type = "string"
    enum = "common.Status"
    required = true
    unique = true
    min_len = 1
    max_len = 16
    pattern = "[a-z]+"
    format = "identifier"
  }
}
`,
 common: `component "Identified" {
  field "id" { type = "uuid" }
}
component "Address" {
  field "city" { type = "string" }
}
enum "Status" { values = ["open", "closed"] }
record "Customer" {
  key = ["id"]
  field "id" { type = "uuid" }
}
`,
};
const mixedJson = {
 root: `{
  "modelspec": "1.0-draft-2",
  "module": { "id": "github.com/test/publisher/root", "name": "root", "version": "0.1.0" },
  "components": { "Billing": { "fields": { "address": { "component": "common.Address" } } } },
  "records": { "Order": {
    "use": ["common.Identified"],
    "fields": {
      "customer": { "record": "common.Customer" },
      "billing": { "component": "Billing" },
      "status": { "type": "string", "enum": "common.Status", "required": true, "unique": true, "min_len": 1, "max_len": 16, "pattern": "[a-z]+", "format": "identifier" }
    }
  } }
}
`,
 common: `{
  "modelspec": "1.0-draft-2",
  "module": { "id": "github.com/test/publisher/common", "name": "common", "version": "0.1.0" },
  "components": {
    "Identified": { "fields": { "id": { "type": "uuid" } } },
    "Address": { "fields": { "city": { "type": "string" } } }
  },
  "enums": { "Status": { "values": ["open", "closed"] } },
  "records": { "Customer": { "key": ["id"], "fields": { "id": { "type": "uuid" } } } }
}
`,
};
let mixedChecker;
const trustedMixedChecker=async()=>mixedChecker??=await buildModelChecker(source);
const mixedMeaning = (invalid=false) => `format: meaning/draft-2
id: fixture
name: Fixture meanings
description: A small mixed-model fixture.
license: CC0-1.0
models:
  root: model/root.modelspec.hcl
  common: model/common.modelspec.hcl
concepts:
  - id: order
    kind: entity
    labels: {en: Order}
    description: A purchase order.
    bindings:
      - model: modelspec:///root.Order
        role: instances
${invalid ? `      - model: modelspec:///root.Order
        field: absent
        role: value
` : ''}`;
function recordYaml(module, commit) {
 return `format: modelspec-registry/draft-1
title: ${module} fixture model
description: A fixture ModelSpec module.
status: draft
address: modelspec://github.com/test/publisher/${module}
repository: https://github.com/test/publisher
commit: ${commit}
module: ${module}
source_file: model/${module}.modelspec.hcl
json_file: model/${module}.modelspec.json
licence: MIT
maintainers:
  - trakhimenok
`;
}
function makePublisher(root, invalidMeaning=false, invalidBonus=false) {
 const bare=join(root,'publisher.git'), work=join(root,'publisher-work');
 execFileSync('git',['init','--bare','--initial-branch=main','-q',bare]);
 execFileSync('git',['init','--initial-branch=main','-q',work]);
 const put=(path,text)=>{mkdirSync(dirname(join(work,path)),{recursive:true});writeFileSync(join(work,path),text);};
 put('model/root.modelspec.hcl',mixedHcl.root);put('model/root.modelspec.json',mixedJson.root);
 put('model/common.modelspec.hcl',mixedHcl.common);put('model/common.modelspec.json',mixedJson.common);
 put('model/bonus.modelspec.hcl',mixedHcl.common);
 const bonus=JSON.parse(mixedJson.common);bonus.module.id='github.com/test/publisher/bonus';bonus.module.name='bonus';
 if(invalidBonus)bonus.components.Address.fields.city.type='int';
 put('model/bonus.modelspec.json',JSON.stringify(bonus,null,2)+'\n');
 put('fixture.meaning.yaml',mixedMeaning(invalidMeaning));put('LICENSE','MIT License\n');
 execFileSync('git',['-C',work,'add','.']);execFileSync('git',['-C',work,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','publisher fixture']);
 const commit=execFileSync('git',['-C',work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 execFileSync('git',['-C',work,'remote','add','origin',bare]);execFileSync('git',['-C',work,'push','-qu','origin','main']);
 return {bare,work,commit};
}
function setMixedRegistry(f, publisher, {lock=true, attached=true}={}) {
 const root=f.root, commit=publisher.commit, repo='https://github.com/test/publisher';
 unlinkSync(join(root,'models/$records/chinook.yaml'));
 writeFileSync(join(root,'models/$records/root.yaml'),recordYaml('root',commit));
 writeFileSync(join(root,'models/$records/common.yaml'),recordYaml('common',commit));
 if(lock)writeFileSync(join(root,'model_dependencies/$records/root--common.yaml'),`model: root\ncommit: ${commit}\nalias: common\ntarget_model: common\ntarget_commit: ${commit}\n`);
 writeFileSync(join(root,'graphs/$records/fixture.yaml'),`format: meaning-registry/draft-1\ntitle: Mixed fixture\ndescription: Native models with optional semantic annotations.\nkind: dataset\nstatus: draft\naddress: meaning://github.com/test/publisher\nrepository: ${repo}\ncommit: ${commit}\nmeaning_files:\n  - fixture.meaning.yaml\nmeaning_licence: CC0-1.0\nmodel_files:\n  - model/root.modelspec.hcl\n  - model/root.modelspec.json\n  - model/common.modelspec.hcl\n  - model/common.modelspec.json\n  - model/bonus.modelspec.hcl\n  - model/bonus.modelspec.json\n${attached?'model_licence: MIT\n':''}maintainers:\n  - trakhimenok\n`);
 writeFileSync(join(root,'tools.json'),JSON.stringify({format:'meaninggraph-tools/v1',meaning:{repository:'https://github.com/meaninggraph/core',commit:'25242a6c84d1b8d4799c718ef237944a429835ba',entrypoint:'scripts/lib/meaning.mjs'},model:{repository:'https://github.com/modelspec-org/cli',commit:'21c631470d1564b17eb7d68e63e7d052f54291c6',moduleVersion:'v0.3.0',profile:'default'}},null,2)+'\n');
 reindex(root);
 const sourceFor=async(_repository,pin)=>{assert.equal(pin,commit);return pinnedSource(publisher.bare,pin);};
 const urlFor=url=>url==='https://github.com/test/publisher'?publisher.bare:url;
 return {sourceFor,urlFor};
}

test('mixed native model closure and attached meaning graph validate with the trusted ModelSpec checker',async t=>{
 const f=setup(t),publisher=makePublisher(f.root),load=setMixedRegistry(f,publisher),modelChecker=await trustedMixedChecker();
 const {checkModels:_discard,...base}=f;
 const result=await buildCatalog({...base,...load,fixture:true,modelChecker});
 assert.deepEqual(result.models.map(m=>m.id).sort(),['common','root']);
 assert.deepEqual(result.graphs.map(g=>g.id),['fixture']);
 const rootRevision=result.revisions.find(r=>r.registry_id==='root');
 assert.deepEqual(rootRevision.dependency_pins,[{alias:'common',revision_id:revisionId('model','modelspec://github.com/test/publisher/common',publisher.commit)}]);
 const commonRevision=result.revisions.find(r=>r.registry_id==='common');
 assert.equal(commonRevision.logical_digest.algorithm,'meaninggraph-logical-digest/v1');
 const definition=JSON.parse(readFileSync(join(f.output,rootRevision.definition.path),'utf8'));
 assert.deepEqual(definition.ast.records.Order.use,['common.Identified']);
 assert.equal(Object.hasOwn(definition.ast.records.Order,'key'),false,'component supplies Order.id as its key without inventing a declared key');
 assert.equal(definition.ast.records.Order.fields.status.max_len,16);
 assert.equal(definition.ast.records.Order.fields.customer.record,'common.Customer');
 assert.equal(definition.ast.components.Billing.fields.address.component,'common.Address');
 const commonDefinition=JSON.parse(readFileSync(join(f.output,commonRevision.definition.path),'utf8'));
 assert.deepEqual(commonDefinition.ast.records.Customer.key,['id']);
 assert.deepEqual(commonDefinition.ast.enums.Status.values,['open','closed']);
 assert.ok(result.graphs[0].model_files.includes('model/bonus.modelspec.hcl'),'unregistered attached models remain in the graph validation set');
});


test('model-only and mixed catalog paths preserve the same authoritative full-language ModelSpec AST',async t=>{
 const f=setup(t),publisher=makePublisher(f.root),load=setMixedRegistry(f,publisher),checker=await trustedMixedChecker();
 unlinkSync(join(f.root,'graphs/$records/fixture.yaml'));reindex(f.root);
 const {checkModels:_discard,...base}=f;
 const result=await buildCatalog({...base,...load,fixture:true,checkMeanings:false,modelChecker:checker});
 assert.deepEqual(result.graphs,[]);
 const root=result.revisions.find(r=>r.registry_id==='root'),common=result.revisions.find(r=>r.registry_id==='common');
 const rootAST=JSON.parse(readFileSync(join(f.output,root.definition.path),'utf8')).ast;
 const commonAST=JSON.parse(readFileSync(join(f.output,common.definition.path),'utf8')).ast;
 assert.deepEqual(rootAST.records.Order.use,['common.Identified']);
 assert.equal(rootAST.records.Order.fields.customer.record,'common.Customer');
 assert.equal(rootAST.components.Billing.fields.address.component,'common.Address');
 assert.equal(rootAST.records.Order.fields.status.max_len,16);
 assert.deepEqual(commonAST.enums.Status.values,['open','closed']);
});

test('mixed-model checker rejects invalid component-supplied keys, mismatched twins, and missing locks',async t=>{
 const checker=await trustedMixedChecker();
 for(const variant of ['key','twin','lock']) {
  const f=setup(t),publisher=makePublisher(f.root),load=setMixedRegistry(f,publisher,{lock:variant!=='lock'});
  const sourceFor=variant==='key'||variant==='twin'?async(repo,pin)=>{
   const view=await load.sourceFor(repo,pin);
   return {files:view.files,read:path=>{
    let bytes=view.read(path).toString('utf8');
    if(variant==='key'&&path==='model/root.modelspec.hcl')bytes=bytes.replace('  use = ["common.Identified"]','  key = ["absent"]\n  use = ["common.Identified"]');
    if(variant==='key'&&path==='model/root.modelspec.json')bytes=bytes.replace('"use": ["common.Identified"],','"key": ["absent"],\n    "use": ["common.Identified"],');
    if(variant==='twin'&&path==='model/root.modelspec.json')bytes=bytes.replace('"max_len": 16','"max_len": 17');
    return Buffer.from(bytes);
   }};
  }:load.sourceFor;
  const {checkModels:_discard,...base}=f;
  await assert.rejects(buildCatalog({...base,fixture:true,modelChecker:checker,sourceFor,urlFor:load.urlFor}),variant==='key'?/key|absent/:variant==='twin'?/twin|different|mismatch|validation failed/:/unknown module|unresolved|common/i,variant);
 }
});

test('meaning bindings and unregistered attached ModelSpec twins are still checked strictly',async t=>{
 const checker=await trustedMixedChecker();
 const f=setup(t),publisher=makePublisher(f.root,true),load=setMixedRegistry(f,publisher);
 const {checkModels:_discard,...base}=f;
 await assert.rejects(buildCatalog({...base,fixture:true,modelChecker:checker,...load}),/binding|property|absent/);
 const bad=setup(t),badPublisher=makePublisher(bad.root,false,true),badLoad=setMixedRegistry(bad,badPublisher);
 const {checkModels:_discardBad,...badBase}=bad; await assert.rejects(buildCatalog({...badBase,fixture:true,modelChecker:checker,...badLoad}),/bonus|module|validation failed|ModelSpec/);
});

test('historical model attachment licence evidence cannot be relabeled from current registration',async t=>{
 const f=setup(t),p=makePublisher(f.root);
 const commit=message=>{execFileSync('git',['-C',p.work,'add','.']);execFileSync('git',['-C',p.work,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm',message]);execFileSync('git',['-C',p.work,'push','-q','origin','main']);return execFileSync('git',['-C',p.work,'rev-parse','HEAD'],{encoding:'utf8'}).trim();};
 writeFileSync(join(p.work,'LICENSE'),'Apache License\nVersion 2.0\n');const historical=commit('historical Apache model');
 writeFileSync(join(p.work,'LICENSE'),'MIT License\n');p.commit=commit('current MIT model');
 const load=setMixedRegistry(f,p),checker=await trustedMixedChecker();
 const qwork=join(f.root,'consumer-work'),qbare=join(f.root,'consumer.git');
 execFileSync('git',['init','--initial-branch=main','-q',qwork]);execFileSync('git',['init','--bare','--initial-branch=main','-q',qbare]);
 writeFileSync(join(qwork,'consumer.meaning.yaml'),`format: meaning/draft-2
id: consumer
name: Consumer
description: A consumer fixture.
license: CC0-1.0
concepts:
  - id: consumer
    kind: entity
    labels: {en: Consumer}
    description: meaning://github.com/test/publisher/order?ref=${historical}
`);
 execFileSync('git',['-C',qwork,'add','.']);execFileSync('git',['-C',qwork,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','consumer']);execFileSync('git',['-C',qwork,'remote','add','origin',qbare]);execFileSync('git',['-C',qwork,'push','-qu','origin','main']);const qpin=execFileSync('git',['-C',qwork,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 writeFileSync(join(f.root,'graphs/$records/consumer.yaml'),`format: meaning-registry/draft-1
title: Consumer fixture
description: Fixture consumer of historical graph.
kind: dataset
status: draft
address: meaning://github.com/test/consumer
repository: https://github.com/test/consumer
commit: ${qpin}
meaning_files:
  - consumer.meaning.yaml
meaning_licence: CC0-1.0
maintainers:
  - trakhimenok
`);
 writeFileSync(join(f.root,'dependencies/$records/consumer--fixture.yaml'),`graph: consumer
depends_on: fixture
commit: ${historical}
`);reindex(f.root);
 const sourceFor=async(repo,pin)=>pinnedSource(repo.endsWith('/publisher')?p.bare:qbare,pin);
 const urlFor=url=>url==='https://github.com/test/consumer'?qbare:load.urlFor(url);
 const {checkModels:_discard,...base}=f;
 await assert.rejects(buildCatalog({...base,fixture:true,modelChecker:checker,sourceFor,urlFor}),/model licence evidence mismatch/);
 assert.equal(existsSync(f.output),false);
});

test('symlink aliases cannot disguise an output nested in the registry source',async t=>{
 const f=emptyRegistry(t);const {symlinkSync}=await import('node:fs');const alias=join(tmpdir(),`mg-review-link-${process.pid}`);symlinkSync(f.root,alias,'dir');t.after(()=>unlinkSync(alias));
 const head=execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim();
 await assert.rejects(buildCatalog({root:f.root,output:join(alias,'unexpected-output'),baselineCommit:head}),/disjoint from registry source/);
 assert.equal(existsSync(join(f.root,'unexpected-output')),false);
});
