import {randomUUID, createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile, lstat, unlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export const REVISION_FORMAT = 'meaninggraph-revision/draft-1';
export const CATALOG_FORMAT = 'meaninggraph-catalog/draft-1';
const sha40 = /^[0-9a-f]{40}$/;
const sha64 = /^[0-9a-f]{64}$/;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const artifactPath = digest => {
  if (!sha64.test(digest)) throw new Error('invalid artifact digest');
  return `artifacts/sha256/${digest.slice(0, 2)}/${digest}`;
};
export function canonicalAddress(kind,address) {
  if(typeof address!=='string')throw new Error('invalid resource address');
  const match=(kind==='meaning'?/^(meaning:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/:/^(modelspec:\/\/github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z_][A-Za-z0-9_]*)$/).exec(address);
  if(!match)throw new Error('invalid resource address');
  return `${match[1]}${match[2].toLowerCase()}/${match[3].toLowerCase()}${kind==='model'?'/'+match[4]:''}`;
}
export function canonicalRepository(repository) {
  if(typeof repository!=='string'||!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw new Error('invalid source repository');
  return repository.toLowerCase();
}

export function revisionId(kind, address, commit) {
  const pattern = kind === 'meaning'
    ? /^meaning:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
    : kind === 'model' ? /^modelspec:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z_][A-Za-z0-9_]*$/ : null;
  if (!pattern?.test(address) || address.split('/').some(part => part === '.' || part === '..') || !sha40.test(commit)) throw new Error('invalid revision identity');
  return sha256(JSON.stringify(['meaninggraph-revision/v1', kind, canonicalAddress(kind,address), commit]));
}

export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
}

// Objects are canonicalized; arrays retain order. Model logical digests are
// produced separately by the lossless Go adapter, never through JS numbers.
export function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-JSON metadata');
  return encoded;
}

export function validateRevision(revision) {
  if (revision?.format !== REVISION_FORMAT || revision.id !== revisionId(revision.kind, revision.address, revision.commit)) throw new Error('invalid revision record');
  if (!Array.isArray(revision.files) || !revision.files.length || !Array.isArray(revision.dependency_pins)) throw new Error('incomplete revision record');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(revision.repository) || typeof revision.registry_id !== 'string' || !revision.registry_id || !Array.isArray(revision.maintainers) || !revision.maintainers.length || revision.maintainers.some(value => typeof value !== 'string' || !value) || !revision.licences || typeof revision.licences !== 'object') throw new Error('incomplete revision provenance');
  const source = revision.source_record;
  if (!source || !safePath(source.path) || !sha40.test(source.commit) || !sha64.test(source.sha256) || source.artifactPath !== artifactPath(source.sha256) || typeof source.repository !== 'string') throw new Error('invalid source record provenance');
  if(revision.acquisition_record){const evidence=revision.acquisition_record;if(!safePath(evidence.path)||!sha40.test(evidence.commit)||!sha64.test(evidence.sha256)||evidence.artifactPath!==artifactPath(evidence.sha256)||typeof evidence.repository!=='string')throw new Error('invalid acquisition record');}
  const formats = revision.kind === 'model' ? ['1.0-draft', '1.0-draft-2'] : ['meaning/draft-1', 'meaning/draft-2'];
  if (!formats.includes(revision.format_identifier)) throw new Error('unknown revision format');
  if (revision.kind === 'model' && (!revision.module?.id || !revision.module.version || revision.logical_digest?.algorithm !== 'meaninggraph-logical-digest/v1' || !sha64.test(revision.logical_digest?.sha256))) throw new Error('incomplete model revision');
  if (revision.definition && (!sha64.test(revision.definition.sha256) || revision.definition.path !== `definitions/${revision.id}.json`)) throw new Error('invalid native definition');
  const seen = new Set();
  for (const file of revision.files) {
    if (!safePath(file.path) || seen.has(file.path) || !file.mediaType || !sha64.test(file.sha256) || file.artifactPath !== artifactPath(file.sha256)) throw new Error('invalid revision artifact');
    seen.add(file.path);
  }
  const aliases = new Set();
  for (const lock of revision.dependency_pins) {
    if (typeof lock.alias !== 'string' || !lock.alias || aliases.has(lock.alias) || !sha64.test(lock.revision_id)) throw new Error('invalid dependency lock');
    aliases.add(lock.alias);
  }
  return revision;
}

export function validateSelections(entries) {
  const pins = new Map();
  const identities = new Set();
  for (const entry of entries) {
    const identity = `${entry.kind}:${canonicalAddress(entry.kind,entry.address)}`;
    if (identities.has(identity)) throw new Error(`duplicate selected identity ${identity}`);
    identities.add(identity);
    if (!sha40.test(entry.commit)) throw new Error(`invalid selected pin ${entry.address}`);
    const repository=canonicalRepository(entry.repository);
    const known = pins.get(repository);
    if (known && known !== entry.commit) throw new Error(`conflicting selected commits for ${entry.repository}: ${known} and ${entry.commit}`);
    pins.set(repository, entry.commit);
  }
  return Object.fromEntries([...pins].sort(([a], [b]) => a.localeCompare(b)));
}

// Reject links in every retained-store path component, including its root.
// The build/release process owns this staging tree exclusively.
async function checkedPath(root, path) {
  if(!safePath(path))throw new Error('unsafe retained-store path');
  const base=resolve(root);
  const rootStat=await lstat(base);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new Error('unsafe retained-store root');
  const target=join(base,path);
  let current=target;
  while(current!==base) {
    try {if((await lstat(current)).isSymbolicLink())throw new Error('symlink in retained-store path');}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    current=dirname(current);
  }
  return target;
}
async function readRetained(root,path) {
  const target=await checkedPath(root,path);
  if(!(await lstat(target)).isFile())throw new Error('not a regular retained file');
  return readFile(target);
}

// Never overwrite an immutable record or artifact. Equal writes are no-ops;
// callers publish a new selection/index separately after complete validation.
export async function writeImmutable(root, path, bytes) {
  if (!safePath(path)) throw new Error('unsafe immutable output path');
  await mkdir(root, {recursive: true});
  const target = await checkedPath(root, path);
  await mkdir(dirname(target), {recursive: true});
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || !Buffer.from(bytes).equals(await readFile(target))) throw new Error(`immutable conflict at ${path}`);
    return false;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // wx makes a competing writer fail rather than replacing existing bytes.
  await writeFile(target, bytes, {flag: 'wx'});
  return true;
}

export async function retainRevision(root, revision, artifacts, sourceRecordBytes, definitionBytes, acquisitionRecordBytes) {
  validateRevision(revision);
  if (!sourceRecordBytes || sha256(sourceRecordBytes) !== revision.source_record.sha256) throw new Error('source record digest-mismatch');
  if(revision.acquisition_record&&(!acquisitionRecordBytes||sha256(acquisitionRecordBytes)!==revision.acquisition_record.sha256))throw new Error('acquisition record digest-mismatch');
  if (revision.definition) {
    if (!definitionBytes || sha256(definitionBytes) !== revision.definition.sha256) throw new Error('native definition digest-mismatch');
    const native = JSON.parse(Buffer.from(definitionBytes).toString('utf8'));
    if (native.format !== 'meaninggraph-definition/draft-1' || native.revision_id !== revision.id || native.kind !== revision.kind) throw new Error('native definition identity mismatch');
  }
  for (const file of revision.files) {
    const bytes = artifacts.get(file.path);
    if (!bytes || sha256(bytes) !== file.sha256) throw new Error(`digest-mismatch: ${file.path}`);
  }
  // Validate every input before writing any of this revision's artifacts.
  await writeImmutable(root, revision.source_record.artifactPath, sourceRecordBytes);
  if(revision.acquisition_record)await writeImmutable(root,revision.acquisition_record.artifactPath,acquisitionRecordBytes);
  if (revision.definition) await writeImmutable(root, revision.definition.path, definitionBytes);
  for (const file of revision.files) await writeImmutable(root, file.artifactPath, artifacts.get(file.path));
  await writeImmutable(root, `revisions/$records/${revision.id}.yaml`, `${stableJSON(revision)}\n`);
}

export async function resolveRevision(root, {kind, address, commit}, visited = new Set()) {
  const requested = {kind, address, commit};
  let id;
  try { id = revisionId(kind, address, commit); }
  catch { return {error: 'unknown-revision', requested_identity: requested}; }
  let revision;
  try {
    revision = validateRevision(JSON.parse((await readRetained(root, `revisions/$records/${id}.yaml`)).toString('utf8')));
    if (revision.id !== id) throw new Error('requested and retained revision identities differ');
  }
  catch (error) { return {error: error.code === 'ENOENT' ? 'unknown-revision' : 'incomplete-revision', requested_identity: requested}; }
  const artifacts = new Map();
  try {
    if (sha256(await readRetained(root, revision.source_record.artifactPath)) !== revision.source_record.sha256) return {error: 'digest-mismatch', requested_identity: requested};
  } catch { return {error: 'incomplete-revision', requested_identity: requested}; }
  if(revision.acquisition_record){
    try {if(sha256(await readRetained(root,revision.acquisition_record.artifactPath))!==revision.acquisition_record.sha256)return {error:'digest-mismatch',requested_identity:requested};}
    catch{return {error:'incomplete-revision',requested_identity:requested};}
  }
  for (const file of revision.files) {
    let bytes;
    try {
      bytes = await readRetained(root, file.artifactPath);
    } catch { return {error: 'incomplete-revision', requested_identity: requested}; }
    if (sha256(bytes) !== file.sha256) return {error: 'digest-mismatch', requested_identity: requested};
    artifacts.set(file.path, bytes);
  }
  let definition;
  if (revision.definition) {
    try {
      const bytes = await readRetained(root, revision.definition.path);
      if (sha256(bytes) !== revision.definition.sha256) return {error: 'digest-mismatch', requested_identity: requested};
      // Return the original JSON bytes too: clients must not round large
      // numeric model constraints through JS numbers when reserializing.
      definition = {bytes, metadata: JSON.parse(bytes.toString('utf8'))};
      if (definition.metadata.revision_id !== id || definition.metadata.kind !== kind) throw new Error('identity mismatch');
    } catch { return {error: 'incomplete-revision', requested_identity: requested}; }
  }
  const dependency_resolution = [];
  if (!visited.has(id)) {
    visited.add(id);
    for (const lock of revision.dependency_pins) {
      let target;
      try {
        target = validateRevision(JSON.parse((await readRetained(root, `revisions/$records/${lock.revision_id}.yaml`)).toString('utf8')));
        if (target.id !== lock.revision_id) throw new Error('dependency identity mismatch');
      } catch { return {error: 'unresolved-dependency', dependency_id: lock.revision_id, requested_identity: requested}; }
      if (visited.has(target.id)) { dependency_resolution.push({alias: lock.alias, revision_id: target.id, cycle: true}); continue; }
      const resolved = await resolveRevision(root, target, visited);
      if (resolved.error) return {error: 'unresolved-dependency', dependency_id: target.id, cause: resolved.error, requested_identity: requested};
      dependency_resolution.push({alias: lock.alias, revision_id: target.id, exact_commit: target.commit});
    }
  }
  return {revision_id: id, exact_commit: revision.commit, original_paths: revision.files.map(file => file.path), artifacts, provenance: revision, definition, dependency_resolution};
}

export function selectRevision(catalog, kind, address) {
  if (catalog?.format !== CATALOG_FORMAT) throw new Error('unknown catalog format');
  const entries = kind === 'model' ? catalog.models : kind === 'meaning' ? catalog.graphs : null;
  if (!entries) throw new Error('unknown resource kind');
  const selected = entries.find(entry => canonicalAddress(kind,entry.address) === canonicalAddress(kind,address));
  return selected ? {kind, address, commit: selected.commit} : null;
}

export async function publishCatalog(root, catalog) {
  const entries = [...catalog.models.map(entry => ({...entry, kind: 'model'})), ...catalog.graphs.map(entry => ({...entry, kind: 'meaning'}))];
  validateSelections(entries);
  // Every selected revision must be present and intact before selection moves.
  for (const entry of entries) {
    const resolved = await resolveRevision(root, entry);
    if (resolved.error) throw new Error(`${resolved.error}: ${entry.address}@${entry.commit}`);
    if (!resolved.definition || resolved.provenance.registry_id !== entry.id) throw new Error(`incomplete native definition: ${entry.address}@${entry.commit}`);
  }
  if(catalog.revision_index) {
    if(catalog.revision_index.path!=='revisions/index.json'||!sha64.test(catalog.revision_index.sha256)||sha256(await readRetained(root,'revisions/index.json'))!==catalog.revision_index.sha256)throw new Error('invalid revision index digest');
  }
  const body = {format: CATALOG_FORMAT, graphs: catalog.graphs, models: catalog.models, source_revisions: validateSelections(entries),...(catalog.revision_index?{revision_index:catalog.revision_index}:{})};
  const bytes = `${stableJSON({...body, checksum: `sha256:${sha256(stableJSON(body))}`})}\n`;
  const temporary = await checkedPath(root, `.catalog-${randomUUID()}.next`);
  try {
    await writeFile(temporary, bytes, {flag: 'wx'});
    await rename(temporary, await checkedPath(root, 'catalog.json'));
  } finally {await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return bytes;
}
