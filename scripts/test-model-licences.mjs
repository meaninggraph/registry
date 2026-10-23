import {test} from 'node:test';
import assert from 'node:assert/strict';
import {declaredLicence,licenceProblems,repositoryLicences} from './lib/model-licences.mjs';
const view=(files)=>({files:Object.keys(files),read:path=>{const value=files[path];if(value===undefined)throw new Error('not a regular file');return Buffer.from(value);}});

test('ModelSpec licence detection recognizes upstream titles and first-ten-line declarations',()=>{
  assert.equal(declaredLicence('# Licence: MIT (https://example.test)\n'), 'MIT');
  assert.equal(declaredLicence('// SPDX-License-Identifier: Apache-2.0\n'), 'Apache-2.0');
  assert.equal(declaredLicence(`${'\n'.repeat(10)}# Licence: MIT`),null);
  assert.equal(declaredLicence('record "A" {}\n'),null);
  assert.deepEqual(licenceProblems('models/$records/a.yaml',view({LICENSE:'The MIT License (MIT)\n'}),'model/a.modelspec.hcl',null,'MIT'),[]);
});

test('unsuffixed repository licence wins over suffixed files, including unrecognized defaults',()=>{
  const licenses=view({LICENSE:'Proprietary text\n','LICENSE-MIT':'The MIT License\n'});
  assert.deepEqual([...repositoryLicences(licenses).all],['MIT']);
  assert.deepEqual([...repositoryLicences(licenses).main],[]);
  assert.match(licenceProblems('record',licenses,'model/a.modelspec.hcl',null,'MIT')[0],/file names no licence the check recognises/);
});

test('ambiguous repository defaults require a model file declaration',()=>{
  const licenses=view({'LICENSE-MIT':'The MIT License\n','LICENSE-CC0':'CC0 1.0 Universal\n'});
  assert.match(licenceProblems('record',licenses,'model/a.modelspec.hcl',null,'MIT')[0],/several \(MIT, CC0-1.0\)/);
  assert.deepEqual(licenceProblems('record',licenses,'model/a.modelspec.hcl','MIT','MIT'),[]);
  assert.match(licenceProblems('record',licenses,'model/a.modelspec.hcl','BSD-3-Clause','MIT')[0],/declares BSD-3-Clause/);
});

test('ModelSpec JSON without a declaration requires one unambiguous repository default',()=>{
  const noLicense=view({'LICENSE-UNKNOWN':'unknown text\n'});
  assert.match(licenceProblems('record',noLicense,'model/a.modelspec.json',null,'MIT')[0],/a JSON file cannot declare one/);
});
