import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, lstatSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, writeFile, rename, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {declaredLicence, licenceProblems} from './model-licences.mjs';
import {homepageProblem} from './urls.mjs';
import {parseDocument} from 'yaml';
import {addressOf, buildIndex, cacheDirFor, checkRegistry, defaultBranch, fetchCommit, gitEnv, onBranch, readCollection, readRegistry, loadChecker} from './registry.mjs';
import {canonicalAddress, validateRevision, artifactPath, publishCatalog, retainRevision, revisionId, resolveRevision, safePath, sha256, stableJSON, writeImmutable} from './revisions.mjs';

const commitPattern=/^[0-9a-f]{40}$/;
const digestPattern=/^[0-9a-f]{64}$/;
const modulePattern=/^[A-Za-z][A-Za-z0-9_]*$/;
const modelColumns=new Set(['format','title','description','status','homepage','address','repository','commit','module','source_file','json_file','licence','maintainers']);
const statuses=new Set(['draft','published','deprecated']);
const byId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
const mediaType=path=>path.endsWith('.json')?'application/json':path.endsWith('.yaml')?'application/yaml':path.endsWith('.hcl')?'application/hcl':'text/plain';

export function modelRecordProblems(records,maintainers) {
  const handles=new Set(maintainers.map(x=>x.key));const addresses=new Set();const errors=[];
  for(const {key,data:d} of records) {
    if(Object.keys(d).some(k=>!modelColumns.has(k)))errors.push(`${key}: unknown model metadata column`);
    if(d.homepage!==undefined&&homepageProblem(d.homepage))errors.push(`${key}: invalid homepage`);
    if(!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(d.licence??''))errors.push(`${key}: invalid SPDX licence identifier`);
    const prefix=addressOf(d.repository)?.replace(/^meaning:/,'modelspec:');
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)||key.length>80||d.format!=='modelspec-registry/draft-1'||!prefix||!modulePattern.test(d.module)||d.address!==`${prefix}/${d.module}`||!commitPattern.test(d.commit??'')) errors.push(`${key}: invalid model identity/source pin`);
    let canonical;try{canonical=canonicalAddress('model',d.address);}catch{}
    if(canonical&&addresses.has(canonical))errors.push(`${key}: duplicate model address`);if(canonical)addresses.add(canonical);
    if(!d.title||!d.description||!statuses.has(d.status)||!d.licence||!safePath(d.source_file)||!d.source_file.endsWith('.modelspec.hcl')||!safePath(d.json_file)||!d.json_file.endsWith('.modelspec.json')) errors.push(`${key}: incomplete model metadata`);
    if(!Array.isArray(d.maintainers)||!d.maintainers.length||d.maintainers.some(x=>!handles.has(x)))errors.push(`${key}: unresolved maintainer`);
  }
  return errors;
}

function rawGit(dir,args) {return execFileSync('git',['--no-pager','-c','core.fsmonitor=false','-C',dir,...args],{env:gitEnv(),maxBuffer:32<<20});}

// Only blobs explicitly tracked as regular files at the verified commit are
// read. No checkout filters, symlinks, publisher executables or branch heads.
export function pinnedSource(dir,commit) {
  if(!commitPattern.test(commit))throw new Error('invalid source commit');
  const rows=rawGit(dir,['ls-tree','-rlz',commit]).toString('utf8').split('\0').filter(Boolean);
  const files=new Map(rows.map(row=>{const at=row.indexOf('\t');return [row.slice(at+1),row.slice(0,at).trim().split(/\s+/)];}));
  return {
    files:[...files.keys()],
    read(path) {
      if(!safePath(path)||!['100644','100755'].includes(files.get(path)?.[0]))throw new Error(`not a pinned regular source file: ${path}`);
      if(Number(files.get(path)[3])>5*1024*1024)throw new Error(`source file exceeds 5 MiB: ${path}`);
      return rawGit(dir,['show',`${commit}:${path}`]);
    },
  };
}

function modelSummary(ast) {
  const records=ast.records??ast.entities??{};
  const field=(name,d,key)=>({name,...(d.type?{type:d.type}:d.record||d.entity?{type:'reference',references:d.record??d.entity}:{type:'component',component:d.component}),required:d.required===true,...(key?{key:key.includes(name)}:{})});
  return {
    records:Object.entries(records).map(([name,d])=>({name,key:[...(d.key??[])],use:[...(d.use??[])],fields:Object.entries(d.fields??d.properties??{}).map(([n,f])=>field(n,f,d.key??[]))})),
    components:Object.entries(ast.components??{}).map(([name,d])=>({name,fields:Object.entries(d.fields??{}).map(([n,f])=>field(n,f))})),
  };
}

export function legacyModelEntry(key,d,ast) {
  return {id:key,title:d.title,description:d.description,status:d.status,...(d.homepage===undefined?{}:{homepage:d.homepage}),address:d.address,repository:d.repository,commit:d.commit,module:d.module,module_id:ast.module.id,module_version:ast.module.version,modelspec:ast.modelspec,licence:d.licence,files:{source:d.source_file,json:d.json_file},maintainers:[...d.maintainers],...modelSummary(ast)};
}

export function legacyModelIndex(entries) {
  const models=[...entries].sort(byId);return `${JSON.stringify({format:'modelspec-registry/draft-1',checksum:`sha256:${sha256(JSON.stringify(models))}`,models},null,2)}\n`;
}

function parsedYAML(bytes,path) {
  const doc=parseDocument(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{uniqueKeys:true});
  if(doc.errors.length)throw new Error(`${path}: ${doc.errors[0].message}`);
  return doc.toJS();
}

function matchedPaths(view,patterns) {
  const found=new Set();
  for(const pattern of patterns) {
    if(!safePath(pattern))throw new Error(`unsafe source pattern ${pattern}`);
    const re=new RegExp(`^${pattern.split('*').map(s=>s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')}$`);
    const matches=view.files.filter(p=>re.test(p));if(!matches.length)throw new Error(`unmatched source pattern ${pattern}`);
    for(const path of matches)found.add(path);
  }
  return [...found].sort();
}

async function preserveExisting(root,output) {
  // Existing native history is copied intact. Any later selection verifies its
  // digest/identity; writeImmutable refuses attempts to rewrite retained bytes.
  for(const top of ['artifacts','revisions','definitions']) {
    const walk=async path=>{
      for(const entry of await readdir(path,{withFileTypes:true})) {
        const full=join(path,entry.name);if(entry.isSymbolicLink())throw new Error(`symlink in retained history ${full}`);
        if(entry.isDirectory())await walk(full);
        else if(entry.isFile())await writeImmutable(output,relative(root,full).split('\\').join('/'),await readFile(full));
        else throw new Error('unsupported retained history entry');
      }
    };
    if(existsSync(join(root,top))) {
      if(lstatSync(join(root,top)).isSymbolicLink())throw new Error(`symlink in retained history root ${top}`);
      await walk(join(root,top));
    }
  }
}

// The protected default-branch merge base is the preservation baseline. CI
// fetches full history; an explicit full ancestor pin can make a release dry run
// reproducible. Candidate records/indexes cannot erase that baseline together.
export function auditHistoryBaseline(root,baselineCommit) {
  let baseline=baselineCommit;
  if(!baseline) {
    let ref;
    try {ref=rawGit(root,['symbolic-ref','refs/remotes/origin/HEAD']).toString().trim();}
    catch {ref='refs/remotes/origin/main';}
    try {baseline=rawGit(root,['merge-base','HEAD',ref]).toString().trim();}
    catch {throw new Error('protected registry baseline unavailable; fetch default branch history');}
  }
  if(!commitPattern.test(baseline))throw new Error('baseline must be a full registry commit');
  try {rawGit(root,['merge-base','--is-ancestor',baseline,'HEAD']);}
  catch {throw new Error('registry baseline must be an ancestor of HEAD');}
  const view=pinnedSource(root,baseline);
  const immutable=view.files.filter(p=>/^(?:artifacts\/sha256\/|definitions\/|revisions\/\$records\/)/.test(p));
  for(const path of immutable) {
    let current;
    try {
      let at=path;
      while(at.includes('/')){at=at.slice(0,at.lastIndexOf('/'));if(lstatSync(join(root,at)).isSymbolicLink())throw new Error('symlink');}
      if(!lstatSync(join(root,path)).isFile()||lstatSync(join(root,path)).isSymbolicLink())throw new Error('not a file');
      current=readFileSync(join(root,path));
    }catch {throw new Error(`published history removed or linked: ${path}`);}
    if(!current.equals(view.read(path)))throw new Error(`published history changed: ${path}`);
  }
  return {commit:baseline,immutable_files:immutable.length};
}

export function registryInputSnapshot(root) {
  const commit=rawGit(root,['rev-parse','HEAD']).toString().trim();
  const scopes=['.ingitdb','.github','graphs','models','dependencies','model_dependencies','maintainers','imports','tools.json','tools','scripts','package.json','package-lock.json'];
  const listed=rawGit(root,['ls-files','--cached','--others','--exclude-standard','-z','--',...scopes]).toString().split('\0').filter(Boolean);
  const committed=pinnedSource(root,commit);
  const relevant=path=>scopes.some(scope=>path===scope||path.startsWith(scope+'/'));
  const paths=[...new Set([...listed,...committed.files.filter(relevant)])].sort();
  const inputs=[];let clean=true;
  for(const path of paths) {
    if(!safePath(path))throw new Error('unsafe registry input path');
    let bytes;
    try {
      if(!lstatSync(join(root,path)).isFile()||lstatSync(join(root,path)).isSymbolicLink())throw new Error('not a regular file');
      bytes=readFileSync(join(root,path));
    }catch(error){if(error.code!=='ENOENT')throw error;clean=false;inputs.push({path,deleted:true});continue;}
    const digest=sha256(bytes);inputs.push({path,sha256:digest});
    try {if(!bytes.equals(committed.read(path)))clean=false;}catch{clean=false;}
  }
  return {mode:clean?'committed':'working-copy',commit,sha256:sha256(stableJSON(inputs)),inputs,activation_eligible:clean};
}

// Caller supplies a registry-owned checker binary, not executable publisher
// content. Injected source/checker functions are only for explicitly marked tests.
export async function buildCatalog(options) {
  const {root,fixture=false}=options;
  if(!options.output)throw new Error('use a new staging output directory');
  const canonicalFuture=async(path)=>{
    let cursor=resolve(path);const suffix=[];
    while(true) {
      try {return resolve(await realpath(cursor),...suffix.reverse());}
      catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(cursor);if(parent===cursor)throw error;suffix.push(basename(cursor));cursor=parent;}
    }
  };
  const output=await canonicalFuture(options.output),source=await realpath(root);
  const inside=(parent,child)=>{const part=relative(parent,child);return part===''||(part!=='..'&&!part.startsWith(`..${sep}`)&&!isAbsolute(part));};
  if(source===output||!fixture&&(inside(source,output)||inside(output,source)))throw new Error('staging output must be disjoint from registry source');
  if(existsSync(output))throw new Error('staging output already exists; choose a new destination');
  await mkdir(dirname(output),{recursive:true});
  const staging=await mkdtemp(join(dirname(output),`.${basename(output)}-preparing-`));
  try {
    const result=await buildCatalogInto({...options,output:staging});
    await rename(staging,output);
    return result;
  }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}

async function buildCatalogInto({root,output,modelChecker,sourceFor,checkModels,fixture=false,checkMeanings=true,baselineCommit,urlFor,allowWorkingTree=false}) {
  if((sourceFor||checkModels||urlFor)&&!fixture)throw new Error('injected readers require fixture mode');
  if(!output||relative(root,output)==='')throw new Error('use a separate staging output directory');
  await mkdir(output,{recursive:true});
  const registry=readRegistry(root);
  const errors=[...registry.problems,...modelRecordProblems(registry.models,registry.maintainers)];
  if(errors.length)throw new Error(errors.join('\n'));
  let meaningTools;
  if(!checkMeanings&&registry.graphs.length&&!fixture)throw new Error('meaning validation cannot be bypassed');
  const snapshot=registryInputSnapshot(root);
  if(!fixture&&!snapshot.activation_eligible&&!allowWorkingTree)throw new Error('registry inputs differ from committed snapshot; use --allow-working-tree for non-activatable local preparation');
  const baseline=fixture?null:auditHistoryBaseline(root,baselineCommit);
  await preserveExisting(root,output);
  const priorRevisions=[];
  const revisionDirectory=join(output,'revisions/$records');
  if(existsSync(revisionDirectory))for(const name of await readdir(revisionDirectory)) {
    if(!/^[0-9a-f]{64}\.yaml$/.test(name))throw new Error('invalid retained revision filename');
    const revision=validateRevision(JSON.parse(await readFile(join(revisionDirectory,name),'utf8')));
    if(name!==`${revision.id}.yaml`)throw new Error('retained revision filename mismatch');
    const resolved=await resolveRevision(output,revision);
    if(resolved.error)throw new Error(`retained history is incomplete: ${revision.id}: ${resolved.error}`);
    priorRevisions.push(revision);
  }
  const priorById=new Map(priorRevisions.map(revision=>[revision.id,revision]));
  const retainCandidate=async(candidate,artifacts,sourceBytes,native,acquisitionBytes)=>{
    const prior=priorById.get(candidate.id);
    if(prior) {
      // Selection metadata may change. The original receipt's provenance and
      // attribution describe its first admission and never follow registry HEAD.
      for(const key of ['kind','address','registry_id','repository','commit','format_identifier','module','source_paths','dependency_pins','logical_digest','files','definition']) {
        if(stableJSON(prior[key]??null)!==stableJSON(candidate[key]??null))throw new Error(`immutable revision content changed: ${candidate.id}:${key}`);
      }
      return prior;
    }
    await retainRevision(output,candidate,artifacts,sourceBytes,native,acquisitionBytes);
    return candidate;
  };
  const importsPath=join(root,'imports/modelspec-registry.json');
  const imported=existsSync(importsPath)?JSON.parse(readFileSync(importsPath,'utf8')):null;
  const head=rawGit(root,['rev-parse','HEAD']).toString().trim();
  const cache=cacheDirFor(root);const fetched=new Set();const branches=new Map();const views=new Map();
  const getSource=async(repository,commit)=>{
    const key=`${repository}@${commit}`;if(views.has(key))return views.get(key);
    let view;
    if(sourceFor)view=await sourceFor(repository,commit);
    else {
      if(!addressOf(repository))throw new Error('unapproved source repository');
      if(!branches.has(repository))branches.set(repository,defaultBranch(repository));
      if(!onBranch(repository,branches.get(repository),commit,join(cache,'history'),fetched))throw new Error(`source pin is not on default-branch history: ${key}`);
      view=pinnedSource(fetchCommit(repository,commit,join(cache,'graphs')),commit);
    }
    views.set(key,view);return view;
  };
  if(imported) {
    if(imported.format!=='meaninggraph-import-source/v1'||imported.repository!=='https://github.com/modelspec-org/registry'||!commitPattern.test(imported.commit)||!imported.records||Array.isArray(imported.records))throw new Error('invalid ModelSpec import manifest');
    const origin=await getSource(imported.repository,imported.commit);
    for(const [key,record] of Object.entries(imported.records)) {
      if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)||record.path!==`models/$records/${key}.yaml`||!digestPattern.test(record.sha256)||sha256(origin.read(record.path))!==record.sha256)throw new Error(`unverified original model registry record: ${key}`);
    }
  }
  const validate=checkModels??(request=>{
    if(!modelChecker||!lstatSync(modelChecker).isFile())throw new Error('build the trusted modelcheck adapter first');
    let stdout;
    try {stdout=execFileSync(modelChecker,[],{input:JSON.stringify(request),maxBuffer:64<<20});}
    catch(error) {throw new Error(`model validation failed: ${error.stdout?.toString()??error.message}`);}
    return JSON.parse(stdout.toString());
  });
  const sourceRecord=record=>{
    const bytes=readFileSync(join(root,record.file));const old=imported?.records?.[record.key];
    const original=record.file.startsWith('models/')&&old?.sha256===sha256(bytes);
    if(!original&&!fixture) {
      let committed;
      try {committed=rawGit(root,['show',`${head}:${record.file}`]);}catch {throw new Error(`commit source selection record before publishing: ${record.file}`);}
      if(!committed.equals(bytes))throw new Error(`uncommitted source selection record: ${record.file}`);
    }
    return {bytes,metadata:{repository:original?imported.repository:'https://github.com/meaninggraph/registry',commit:original?imported.commit:head,path:original?old.path:record.file,sha256:sha256(bytes),artifactPath:artifactPath(sha256(bytes))},imported:original};
  };
  const modelById=new Map(registry.models.map(r=>[r.key,r]));
  const locks=readCollection(root,'model_dependencies');if(locks.problems.length)throw new Error(locks.problems.join('\n'));
  const modelInputs=new Map();
  const loadModel=async record=>{
    const d=record.data;const key=`${d.address}@${d.commit}`;if(modelInputs.has(key))return modelInputs.get(key);
    const view=await getSource(d.repository,d.commit);
    const hcl=view.read(d.source_file), json=view.read(d.json_file);
    const ast=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json));
    const repoKey=d.repository.slice('https://'.length);
    if(ast.module?.name!==d.module||typeof ast.module.id!=='string'||!ast.module.id.toLowerCase().startsWith(`${repoKey.toLowerCase()}/`)||ast.module.id.split('/').at(-1)!==d.module)throw new Error(`${record.key}: model module identity differs from registration`);
    const loaded={record,view,hcl,json,ast};modelInputs.set(key,loaded);return loaded;
  };
  const retainedModel=async(id,alias,expectedRecord=null)=>{
    if(!digestPattern.test(id))throw new Error(`invalid retained model revision id ${id}`);
    const path=`revisions/$records/${id}.yaml`;
    let revision;
    try {revision=parsedYAML(readFileSync(join(output,path)),path);}
    catch {throw new Error(`unresolved historical model dependency ${alias}: retained revision ${id} is missing`);}
    if(revision?.kind!=='model'||revision.id!==id||id!==revisionId(revision.kind,revision.address,revision.commit))throw new Error(`retained model revision identity mismatch ${id}`);
    if(expectedRecord&&(revision.registry_id!==expectedRecord.key||revision.repository!==expectedRecord.data.repository||revision.address!==expectedRecord.data.address))throw new Error(`historical model dependency ${alias} does not match registered model ${expectedRecord.key}`);
    const resolved=await resolveRevision(output,{kind:'model',address:revision.address,commit:revision.commit});
    if(resolved.error||resolved.revision_id!==id||resolved.exact_commit!==revision.commit)throw new Error(`incomplete historical model dependency ${alias}@${revision.commit}: ${resolved.error??'revision identity mismatch'}`);
    const hclPath=revision.source_paths?.hcl,jsonPath=revision.source_paths?.json;
    if(!safePath(hclPath)||!safePath(jsonPath)||hclPath===jsonPath)throw new Error(`retained model revision ${id} has invalid source_paths`);
    const hclFile=revision.files.find(file=>file.path===hclPath),jsonFile=revision.files.find(file=>file.path===jsonPath);
    const hcl=resolved.artifacts.get(hclPath),json=resolved.artifacts.get(jsonPath);
    if(!hclFile||!jsonFile||!hcl||!json)throw new Error(`retained model revision ${id} is missing its exact HCL/JSON source artifacts`);
    let ast;
    try {ast=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json));}
    catch {throw new Error(`retained model revision ${id} has invalid ModelSpec JSON`);}
    const repoPrefix=revision.repository?.slice('https://'.length).toLowerCase()+'/';
    const addressPrefix=addressOf(revision.repository)?.replace(/^meaning:/,'modelspec:');
    if(!addressPrefix||revision.address!==`${addressPrefix}/${alias}`||typeof ast.module?.id!=='string'||!ast.module.id.toLowerCase().startsWith(repoPrefix)||ast.module.id.split('/').at(-1)!==alias||ast.modelspec!==revision.format_identifier||ast.module?.id!==revision.module?.id||ast.module?.version!==revision.module?.version||ast.module?.name!==alias)throw new Error(`retained model revision ${id} module metadata does not match dependency alias ${alias}`);
    return {revision,revisionId:id,alias,hcl,json,ast};
  };
  // A prior lock is accepted only through its retained immutable revision and
  // exact ModelSpec artifacts. Never substitute the currently selected pin.
  const closure=async(rootRecord)=>{
    const result=[];const visited=new Set();const aliases=new Map();
    const add=async(loaded,alias,id)=>{
      const prior=aliases.get(alias);
      if(prior&&prior!==id)throw new Error(`conflicting locked revisions for module alias ${alias}: ${prior} and ${id}`);
      aliases.set(alias,id);
      if(visited.has(id))return false;
      visited.add(id);result.push({...loaded,alias,revisionId:id});return true;
    };
    const visitRetained=async(loaded)=>{
      if(!await add(loaded,loaded.alias,loaded.revisionId))return;
      for(const lock of loaded.revision.dependency_pins){
        if(!lock||typeof lock.alias!=='string'||!digestPattern.test(lock.revision_id))throw new Error(`invalid retained dependency lock in ${loaded.revisionId}`);
        const target=await retainedModel(lock.revision_id,lock.alias);
        await visitRetained(target);
      }
    };
    const visitSelected=async record=>{
      const d=record.data,id=revisionId('model',d.address,d.commit);
      const loaded=await loadModel(record);
      if(!await add(loaded,d.module,id))return;
      for(const {data:lock} of locks.records.filter(l=>l.data.model===record.key&&l.data.commit===d.commit)) {
        const target=modelById.get(lock.target_model);
        if(!target||lock.alias!==target.data.module||!commitPattern.test(lock.target_commit))throw new Error(`invalid locked module ${record.key}:${lock.alias}`);
        if(lock.target_commit===target.data.commit){await visitSelected(target);continue;}
        const historicalId=revisionId('model',target.data.address,lock.target_commit);
        const historical=await retainedModel(historicalId,lock.alias,target);
        await visitRetained(historical);
      }
    };
    await visitSelected(rootRecord);return result;
  };
  const validatedRequests=new Map();
  const legacy=[];const models=[];const revisions=[];const report={fixture,baseline,registry_snapshot:snapshot,activation_eligible:!fixture&&snapshot.activation_eligible,models:[],graphs:[],unregistered_model_attachments:[]};
  for(const record of registry.models) {
    const d=record.data;const input=await loadModel(record);const source=sourceRecord(record);const modules=await closure(record);
    const request={context:source.imported?'pinned-import':'authoring',modules:modules.map(m=>({alias:m.alias??m.record.data.module,revision_id:m.revisionId,hcl_path:m.revision?.source_paths.hcl??m.record.data.source_file,json_path:m.revision?.source_paths.json??m.record.data.json_file,hcl:new TextDecoder('utf-8',{fatal:true}).decode(m.hcl),json:new TextDecoder('utf-8',{fatal:true}).decode(m.json)}))};
    const checked=validate(request);
    validatedRequests.set(`${d.repository}@${d.commit}:${d.json_file}`,request);
    if(!checked.ok||!checked.ast||!/^sha256:[0-9a-f]{64}$/.test(checked.logical_digest??''))throw new Error(`${record.key}: incomplete semantic validation result`);
    const licence=declaredLicence(new TextDecoder('utf-8',{fatal:true}).decode(input.hcl));
    const licenceErrors=[...licenceProblems(record.file,input.view,d.source_file,licence,d.licence),...licenceProblems(record.file,input.view,d.json_file,licence,d.licence)];
    if(licenceErrors.length)throw new Error(licenceErrors.join('\n'));
    const id=revisionId('model',d.address,d.commit);const artifacts=new Map([[d.source_file,input.hcl],[d.json_file,input.json]]);
    for(const path of input.view.files.filter(p=>/(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)(?:[^/]*)$/i.test(p)))artifacts.set(path,input.view.read(path));
    // ast_json is an exact JSON string from the trusted Go adapter. Parsing
    // it is only a shape check; retaining it verbatim avoids JS number rounding.
    if(typeof checked.ast_json!=='string'||JSON.parse(checked.ast_json)?.module?.id!==input.ast.module.id)throw new Error('missing lossless native AST');
    const header=JSON.stringify({format:'meaninggraph-definition/draft-1',kind:'model',revision_id:id});
    if(!checkModels&&typeof checked.graph_json!=='string')throw new Error('missing typed native model graph');
    if(checked.graph_json){const graph=JSON.parse(checked.graph_json);if(graph.format!=='meaninggraph-model-graph/draft-1'||graph.root_revision_id!==id)throw new Error('invalid typed native model graph');}
    const native=Buffer.from(`${header.slice(0,-1)},"ast":${checked.ast_json}${checked.graph_json?`,"graph":${checked.graph_json}`:''}}\n`);
    const dependency_pins=locks.records.filter(l=>l.data.model===record.key&&l.data.commit===d.commit).map(({data:l})=>({alias:l.alias,revision_id:revisionId('model',modelById.get(l.target_model).data.address,l.target_commit)})).sort((a,b)=>a.alias.localeCompare(b.alias));
    const revision={format:'meaninggraph-revision/draft-1',id,kind:'model',address:d.address,registry_id:record.key,repository:d.repository,commit:d.commit,source_record:source.metadata,format_identifier:input.ast.modelspec,module:input.ast.module,source_paths:{hcl:d.source_file,json:d.json_file},dependency_pins,licences:{model:d.licence},maintainers:[...d.maintainers],logical_digest:{algorithm:'meaninggraph-logical-digest/v1',sha256:checked.logical_digest.slice(7)},files:[...artifacts].map(([path,bytes])=>({path,mediaType:mediaType(path),sha256:sha256(bytes),artifactPath:artifactPath(sha256(bytes))})).sort((a,b)=>a.path.localeCompare(b.path)),definition:{path:`definitions/${id}.json`,sha256:sha256(native)}};
    for(const prior of [...priorRevisions,...revisions])if(prior.kind==='model'&&prior.module.id===revision.module.id&&prior.module.version===revision.module.version&&prior.logical_digest.sha256!==revision.logical_digest.sha256)throw new Error(`logical change without model version change: ${revision.module.id}@${revision.module.version}`);
    const retained=await retainCandidate(revision,artifacts,source.bytes,native);revisions.push(retained);
    const entry=legacyModelEntry(record.key,d,input.ast);legacy.push(entry);models.push({...entry,revision_id:id,definition:revision.definition});
    report.models.push({id:record.key,address:d.address,commit:d.commit,revision_id:id,source_record:source.metadata.sha256,logical_digest:revision.logical_digest,artifacts:revision.files});
  }
  const attachmentChecks=new Map();
  const checkAttachments=async(record,commit,view,paths)=>{
    const cacheKey=`${record.data.repository}@${commit}`;
    if(attachmentChecks.has(cacheKey))return attachmentChecks.get(cacheKey);
    const pairs=[];const validHclTwins=new Set();
    const aliases=new Map();
    for(const path of matchedPaths(view,record.data.meaning_files??['*.meaning.yaml'])) {
      const doc=parsedYAML(view.read(path),path);
      for(const [alias,value] of Object.entries(doc.models??{}))if(typeof value==='string'&&!value.startsWith('modelspec://')) {
        const target=join(dirname(path),value).split('\\').join('/');
        if(safePath(target))aliases.set(target,alias);
      }
    }
    for(const hclPath of paths.filter(p=>p.endsWith('.modelspec.hcl'))) {
      const jsonPath=hclPath.slice(0,-4)+'.json';
      const hasJSON=paths.includes(jsonPath);
      const hcl=new TextDecoder('utf-8',{fatal:true}).decode(view.read(hclPath));
      const json=hasJSON?new TextDecoder('utf-8',{fatal:true}).decode(view.read(jsonPath)):'';
      const alias=hasJSON?JSON.parse(json).module?.name:aliases.get(hclPath)??basename(hclPath,'.modelspec.hcl');
      pairs.push({alias,hcl,json,hclPath,jsonPath:hasJSON?jsonPath:null});
    }
    for(const jsonPath of paths.filter(p=>p.endsWith('.modelspec.json')))if(!pairs.some(p=>p.jsonPath===jsonPath))throw new Error(`${record.key}@${commit}: JSON attachment requires its listed HCL twin`);
    for(const pair of pairs) {
      const known=validatedRequests.get(`${record.data.repository}@${commit}:${pair.jsonPath}`);
      const request=known??{context:'attachment',modules:[pair,...pairs.filter(p=>p!==pair)].map(({alias,hcl,json})=>({alias,hcl,json}))};
      const checked=validate(request);
      if(!checked.ok)throw new Error(`${record.key}@${commit}: invalid attached model ${pair.hclPath}`);
      const declared=declaredLicence(pair.hcl);
      const problems=[...licenceProblems(record.file,view,pair.hclPath,declared,record.data.model_licence),...(pair.jsonPath?licenceProblems(record.file,view,pair.jsonPath,declared,record.data.model_licence):[])];
      if(problems.length)throw new Error(`historical/selected model licence evidence mismatch at ${commit}: ${problems.join('; ')}`);
      if(pair.jsonPath)validHclTwins.add(pair.hclPath);
    }
    const result={problems:[],validHclTwins};attachmentChecks.set(cacheKey,result);return result;
  };
  if(checkMeanings) {
    for(const graph of registry.graphs) {
      const view=await getSource(graph.data.repository,graph.data.commit);
      await checkAttachments(graph,graph.data.commit,view,matchedPaths(view,graph.data.model_files??[]));
    }
    const modelspecTwinChecker=(file,dir,paths,notice,graph)=>attachmentChecks.get(`${graph.data.repository}@${graph.data.commit}`)??{problems:[`${file}: attached model validation was not prepared`],validHclTwins:new Set()};
    const checked=await checkRegistry({root,modelspecTwinChecker,...(urlFor?{urlFor}:{})});
    if(checked.problems.length)throw new Error(checked.problems.join('\n'));
    if(registry.graphs.length)meaningTools=(await loadChecker({root,graphs:registry.graphs,...(urlFor?{urlFor}:{})})).meaning;
  }
  const graphEntries=JSON.parse(buildIndex(registry)).graphs;
  const graphById=new Map(registry.graphs.map(r=>[r.key,r]));const graphDone=new Set();
  const retainGraph=async(record,commit=record.data.commit,origin=record)=>{
    const d=record.data;const id=revisionId('meaning',d.address,commit);if(graphDone.has(id))return id;graphDone.add(id);
    if(commit!==d.commit&&priorById.has(id)){revisions.push(priorById.get(id));return id;}
    const view=await getSource(d.repository,commit);const paths=matchedPaths(view,d.meaning_files??['*.meaning.yaml']);
    const artifacts=new Map(paths.map(path=>[path,view.read(path)]));
    const modelPaths=matchedPaths(view,d.model_files??[]);
    await checkAttachments(record,commit,view,modelPaths);
    for(const path of modelPaths)artifacts.set(path,view.read(path));
    for(const path of view.files.filter(p=>/(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)(?:[^/]*)$/i.test(p)))artifacts.set(path,view.read(path));
    const documents=paths.map(path=>({path,document:parsedYAML(artifacts.get(path),path)}));
    for(const {path,document} of documents) {
      const problems=licenceProblems(record.file,view,path,typeof document.license==='string'?document.license:null,d.meaning_licence);
      if(problems.length)throw new Error(`historical/selected meaning licence evidence mismatch at ${commit}: ${problems.join('; ')}`);
    }
    const formats=[...new Set(documents.map(x=>x.document.format))];if(formats.length!==1||!['meaning/draft-1','meaning/draft-2'].includes(formats[0]))throw new Error(`unknown/mixed graph format ${d.address}@${commit}`);
    const source=sourceRecord(record);const acquisition=origin===record?null:sourceRecord(origin);const dependency_pins=[];
    // Derive locks from the exact archived documents. Current dependency rows
    // describe current selection and cannot relabel a historical graph's edges.
    if(!meaningTools)throw new Error('meaning graph archival requires trusted reference parser');
    const actualPins=new Map();
    for(const {document} of documents)for(const ref of meaningTools.conceptReferences(document)) {
      if(ref.repo===d.address.slice('meaning://'.length)) {
        if(ref.ref&&ref.ref!==commit)throw new Error('cross-version self reference requires explicit retained graph dependency');
        continue;
      }
      const target=[...graphById.values()].find(r=>r.data.address===`meaning://${ref.repo}`);
      if(!target||!commitPattern.test(ref.ref??''))throw new Error(`unresolved/unpinned archived meaning reference ${ref.repo}`);
      const prior=actualPins.get(target.key);
      if(prior&&prior.commit!==ref.ref)throw new Error(`conflicting archived meaning dependency ${target.key}`);
      actualPins.set(target.key,{target,commit:ref.ref});
    }
    for(const [alias,{target,commit:pin}] of [...actualPins].sort(([a],[b])=>a.localeCompare(b))) {
      const declared=registry.dependencies.find(x=>x.data.graph===record.key&&x.data.depends_on===alias&&x.data.commit===pin);
      if(commit===d.commit&&!declared)throw new Error(`selected meaning dependency missing registration ${record.key}:${alias}`);
      dependency_pins.push({alias,revision_id:await retainGraph(target,pin,declared??origin)});
    }
    const native=Buffer.from(`${stableJSON({format:'meaninggraph-definition/draft-1',kind:'meaning',revision_id:id,documents,dependency_pins})}\n`);
    const revision={format:'meaninggraph-revision/draft-1',id,kind:'meaning',address:d.address,registry_id:record.key,repository:d.repository,commit,source_record:source.metadata,...(acquisition?{acquisition_record:acquisition.metadata}:{}),metadata_scope:'registry-admission',selected_registration_commit:d.commit,format_identifier:formats[0],source_paths:{meaning:paths,model:[...artifacts.keys()].filter(p=>p.endsWith('.modelspec.hcl')||p.endsWith('.modelspec.json'))},dependency_pins,licences:{meaning:d.meaning_licence,...(d.model_licence?{model:d.model_licence}:{})},maintainers:[...d.maintainers],files:[...artifacts].map(([path,bytes])=>({path,mediaType:mediaType(path),sha256:sha256(bytes),artifactPath:artifactPath(sha256(bytes))})).sort((a,b)=>a.path.localeCompare(b.path)),definition:{path:`definitions/${id}.json`,sha256:sha256(native)}};
    const retained=await retainCandidate(revision,artifacts,source.bytes,native,acquisition?.bytes);revisions.push(retained);
    return id;
  };
  const graphs=[];
  for(const entry of graphEntries) {
    const id=await retainGraph(graphById.get(entry.id));graphs.push({...entry,revision_id:id,definition:{path:`definitions/${id}.json`,sha256:revisions.find(r=>r.id===id).definition.sha256}});
    report.graphs.push({id:entry.id,address:entry.address,commit:entry.commit,revision_id:id});
    if(entry.model_files?.length&&!registry.models.some(m=>m.data.repository===entry.repository&&entry.model_files.includes(m.data.source_file)))report.unregistered_model_attachments.push({graph:entry.id,files:entry.model_files});
  }
  // Compare old/new legacy contracts before any new selection is published.
  const legacyBytes=legacyModelIndex(legacy);
  await writeFile(join(output,'modelspec-index.json'),legacyBytes);
  await writeFile(join(output,'index.json'),buildIndex(registry));
  const retainedById=new Map([...priorRevisions,...revisions].map(revision=>[revision.id,revision]));
  const existingIndexPath=join(root,'revisions/index.json');
  if(existsSync(existingIndexPath)) {
    let existingIndex;
    try {existingIndex=JSON.parse(readFileSync(existingIndexPath,'utf8'));} catch {throw new Error('existing revisions/index.json is invalid JSON');}
    if(existingIndex?.format!=='meaninggraph-revision-index/draft-1'||!Array.isArray(existingIndex.revisions))throw new Error('existing revisions/index.json has an unsupported format');
    for(const row of existingIndex.revisions) {
      const retained=retainedById.get(row?.id);
      if(!retained||row.kind!==retained.kind||row.address!==retained.address||row.commit!==retained.commit||row.path!==`revisions/$records/${row.id}.yaml`)throw new Error(`existing revision index points to missing or conflicting retained revision ${row?.id}`);
    }
  }
  const revisionIndex={format:'meaninggraph-revision-index/draft-1',revisions:[...retainedById.values()].map(r=>({kind:r.kind,address:r.address,commit:r.commit,id:r.id,path:`revisions/$records/${r.id}.yaml`})).sort(byId)};
  const revisionIndexBytes=`${stableJSON(revisionIndex)}\n`;
  await writeFile(join(output,'revisions/index.json'),revisionIndexBytes);
  await publishCatalog(output,{models:models.sort(byId),graphs:graphs.sort(byId),revision_index:{path:'revisions/index.json',sha256:sha256(revisionIndexBytes)}});
  await writeFile(join(output,'reconciliation.json'),`${stableJSON(report)}\n`);
  return {models,graphs,revisions,report};
}

export async function buildModelChecker(root) {
  const folder=await mkdtemp(join(tmpdir(),'meaninggraph-modelcheck-'));const binary=join(folder,'modelcheck');
  execFileSync('go',['build','-trimpath','-o',binary,'.'],{cwd:join(root,'tools/modelcheck'),stdio:'pipe'});
  return binary;
}
