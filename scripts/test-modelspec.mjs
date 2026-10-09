// Tests of the ModelSpec reader of the registry checks (scripts/lib/modelspec.mjs), CC0-1.0 like
// everything else here. They need no network and no git: the reader is plain functions over text.
// The models are small and invented; each case names the thing it proves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { astDifferences, hclUsesEarlier, parseHcl, parseJson, serializeModel, toModelspecJson, validateModel, vocabularies, vocabularyOf } from './lib/modelspec.mjs';

const module = { id: 'fixture', name: 'Fixture', version: '1.0.0' };
const toJson = (hcl) => toModelspecJson(parseHcl(hcl), module);

// The same model in the earlier spelling, the current spelling, and a file that mixes them.
const earlierHcl = `
entity "Customer" {
  key = ["id"]
  property "id" {
    type = "string"
  }
}
entity "Invoice" {
  key = ["id"]
  use = ["Audit"]
  property "id" {
    type = "string"
  }
  property "customer" {
    entity = "Customer"
  }
}
component "Audit" {
  field "by" {
    type = "string"
  }
}
enum "Status" {
  values = ["open", "paid"]
}
`;
const currentHcl = `
record "Customer" {
  key = ["id"]
  field "id" {
    type = "string"
  }
}
record "Invoice" {
  key = ["id"]
  use = ["Audit"]
  field "id" {
    type = "string"
  }
  field "customer" {
    record = "Customer"
  }
}
component "Audit" {
  field "by" {
    type = "string"
  }
}
enum "Status" {
  values = ["open", "paid"]
}
`;
// The block of one spelling with the members of the other, and a reference word of each.
const mixedHcl = `
record "Customer" {
  key = ["id"]
  property "id" {
    type = "string"
  }
}
entity "Invoice" {
  key = ["id"]
  field "id" {
    type = "string"
  }
  field "customer" {
    record = "Customer"
  }
  property "again" {
    entity = "Customer"
  }
}
`;

test('an earlier-spelling source is the 1.0-draft JSON AST, and the model validates', () => {
  const json = toJson(earlierHcl);
  assert.equal(json.modelspec, '1.0-draft');
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'entities', 'components', 'enums']);
  assert.deepEqual(Object.keys(json.entities.Invoice), ['key', 'use', 'properties']);
  assert.deepEqual(json.entities.Invoice.properties.customer, { entity: 'Customer' });
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(earlierHcl)), true);
});

test('a current-spelling source is the 1.0-draft-2 JSON AST, and the model validates', () => {
  const json = toJson(currentHcl);
  assert.equal(json.modelspec, '1.0-draft-2');
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'records', 'components', 'enums']);
  assert.deepEqual(Object.keys(json.records.Invoice), ['key', 'use', 'fields']);
  assert.deepEqual(json.records.Invoice.fields.customer, { record: 'Customer' });
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(currentHcl)), false);
});

test('the two spellings are the same model: only the words differ', () => {
  const renamed = JSON.parse(serializeModel(toJson(earlierHcl)).replace('"1.0-draft"', '"1.0-draft-2"').replace('"entities"', '"records"').replaceAll('"properties"', '"fields"').replaceAll('"entity"', '"record"'));
  assert.deepEqual(renamed, JSON.parse(serializeModel(toJson(currentHcl))));
});

test('a file that mixes the spellings is exported in the earlier vocabulary, whatever order the words come in', () => {
  const json = toJson(mixedHcl);
  assert.equal(json.modelspec, '1.0-draft');
  assert.deepEqual(Object.keys(json), ['modelspec', 'module', 'entities']);
  assert.deepEqual(json.entities.Invoice.properties.customer, { entity: 'Customer' });
  assert.deepEqual(json.entities.Invoice.properties.again, { entity: 'Customer' });
  assert.deepEqual(validateModel(json), []);
  assert.equal(hclUsesEarlier(parseHcl(mixedHcl)), true);
  // one earlier word anywhere is enough, even only the reference word of a member
  assert.equal(hclUsesEarlier(parseHcl('record "A" {\n  field "a" {\n    entity = "A"\n  }\n}\n')), true);
  assert.equal(toJson('record "A" {\n  field "a" {\n    entity = "A"\n  }\n}\n').modelspec, '1.0-draft');
});

test('a member that has both reference words is refused', () => {
  for (const hcl of [
    'record "A" {\n  field "a" {\n    entity = "A"\n    record = "A"\n  }\n}\n',
    'entity "A" {\n  property "a" {\n    record = "A"\n    entity = "A"\n  }\n}\n',
  ]) assert.throws(() => toJson(hcl), /^Error: line 2: (field|property) "a" has both entity and record; a member refers to one record type$/);
});

test('a record type may have no key, in either spelling', () => {
  for (const hcl of ['entity "A" {\n  property "a" {\n    type = "string"\n  }\n}\n', 'record "A" {\n  field "a" {\n    type = "string"\n  }\n}\n']) {
    const json = toJson(hcl);
    assert.deepEqual(validateModel(json), []);
    assert.equal(Object.values(json.entities ?? json.records).every((type) => !('key' in type)), true);
  }
});

test('removed and reserved constructs are refused by name, anywhere in the source, in either spelling', () => {
  const refused = {
    collection: /the collection block was removed from ModelSpec \(decision 0019\)/,
    recordset: /the recordset block was removed from ModelSpec \(decision 0019\)/,
    column: /the column block was removed from ModelSpec \(decision 0019\)/,
    projection: /the projection block is reserved by ModelSpec and has no content \(decision 0019\); remove it/,
    index: /the index block is reserved by ModelSpec and has no content \(decision 0019\); remove it/,
    migration: /the migration block is reserved by ModelSpec and has no content \(decision 0019\); remove it/,
  };
  for (const [word, message] of Object.entries(refused)) {
    assert.throws(() => toJson(`${currentHcl}\n${word} "X" {}\n`), message, `${word} at the top level`);
    assert.throws(() => toJson(`${earlierHcl}\n${word} "X" {}\n`), message, `${word} at the top level, earlier spelling`);
    assert.throws(() => toJson(`record "A" {\n  field "a" {\n    type = "string"\n  }\n  ${word} "X" {}\n}\n`), message, `${word} inside a record`);
    assert.throws(() => toJson(`entity "A" {\n  property "a" {\n    type = "string"\n  }\n  ${word} "X" {}\n}\n`), message, `${word} inside an entity`);
  }
});

test('other blocks are refused by what the converter supports, and a record type has no unknown attributes', () => {
  assert.throws(() => toJson('widget "W" {}\n'), /^Error: line 1: top-level widget blocks are not supported by this converter \(record, entity, component, enum\)$/);
  assert.throws(() => toJson('record "A" {\n  nonsense = 1\n}\n'), /^Error: line 1: unsupported record attribute nonsense$/);
  assert.throws(() => toJson('entity "A" {\n  nonsense = 1\n}\n'), /^Error: line 1: unsupported entity attribute nonsense$/);
  assert.throws(() => toJson('record "A" {\n  widget "w" {}\n}\n'), /^Error: line 2: record "A" cannot contain a widget block/);
  assert.throws(() => toJson('record "A" {\n  field "a" {\n    field "b" {}\n  }\n}\n'), /^Error: line 2: field "a" cannot contain blocks$/);
  assert.throws(() => toJson('record "A" {\n  field "a" {}\n  field "a" {}\n}\n'), /^Error: line 3: duplicate field "a" in record "A"$/);
  assert.throws(() => toJson('record "A" {}\nentity "A" {}\n'), /^Error: line 2: duplicate entity "A"$/);
  assert.throws(() => toJson('enum "E" {\n  field "a" {}\n}\n'), /^Error: line 1: enum "E" cannot contain blocks$/);
});

test('"records" is a reserved concept name, like entities, components and enums', () => {
  for (const name of ['records', 'entities', 'components', 'enums', 'collections', 'recordsets']) {
    assert.ok(validateModel(toJson(`record "${name}" {}\n`)).includes(`${name} is a reserved name`), name);
    assert.ok(validateModel(toJson(`entity "${name}" {}\n`)).includes(`${name} is a reserved name`), name);
  }
});

test('members named like JavaScript built-ins are ordinary names, in HCL and in JSON', () => {
  for (const [word, field] of [['record', 'field'], ['entity', 'property']]) {
    const hcl = `${word} "constructor" {\n  key = ["toString"]\n  ${field} "toString" {\n    type = "string"\n  }\n  ${field} "__proto__" {\n    type = "string"\n  }\n  ${field} "hasOwnProperty" {\n    ${word} = "constructor"\n  }\n}\n`;
    const json = toJson(hcl);
    const members = (json.records ?? json.entities).constructor[json.records ? 'fields' : 'properties'];
    assert.deepEqual(Object.keys(members), ['toString', '__proto__', 'hasOwnProperty']);
    assert.deepEqual(validateModel(json), []);
    assert.deepEqual(validateModel(parseJson(serializeModel(json))), []);
    assert.deepEqual(astDifferences(json, parseJson(serializeModel(json))), []);
  }
});

const jsonOf = (vocabulary, extra = {}) => ({
  modelspec: vocabulary.identifier,
  module,
  [vocabulary.records]: { A: { key: ['id'], [vocabulary.fields]: { id: { type: 'string' }, b: { [vocabulary.record]: 'A' } } } },
  components: { C: { fields: { x: { type: 'string' } } } },
  ...extra,
});

test('JSON in either vocabulary validates, and the identifier decides the vocabulary', () => {
  assert.deepEqual(validateModel(jsonOf(vocabularies.earlier)), []);
  assert.deepEqual(validateModel(jsonOf(vocabularies.current)), []);
  assert.equal(vocabularyOf(jsonOf(vocabularies.earlier)), vocabularies.earlier);
  assert.equal(vocabularyOf(jsonOf(vocabularies.current)), vocabularies.current);
  assert.equal(vocabularyOf({ modelspec: '2.0' }), undefined);
  assert.equal(vocabularyOf(null), undefined);
});

test('each JSON identifier refuses the other vocabulary\'s key', () => {
  const { earlier, current } = vocabularies;
  // 1.0-draft-2 with entities, with properties in a record type, with entity on a member (in a record type and in a component)
  assert.deepEqual(validateModel(jsonOf(current, { entities: {} })), ['"entities" is a key of format 1.0-draft; this document says "1.0-draft-2", where it is "records"']);
  const withProperties = jsonOf(current);
  withProperties.records.A.properties = {};
  assert.deepEqual(validateModel(withProperties), ['record A: "properties" is a key of format 1.0-draft; this document says "1.0-draft-2", where it is "fields"']);
  const withEntity = jsonOf(current);
  withEntity.records.A.fields.b = { entity: 'A' };
  assert.deepEqual(validateModel(withEntity), ['A.b: "entity" is a key of format 1.0-draft; this document says "1.0-draft-2", where it is "record"', 'A.b must have exactly one of type, record, component']);
  const inComponent = jsonOf(current);
  inComponent.components.C.fields.x = { entity: 'A' };
  assert.deepEqual(validateModel(inComponent), ['C.x: "entity" is a key of format 1.0-draft; this document says "1.0-draft-2", where it is "record"', 'C.x must have exactly one of type, record, component']);
  // 1.0-draft with records, with fields in a record type, with record on a member
  assert.deepEqual(validateModel(jsonOf(earlier, { records: {} })), ['"records" is a key of format 1.0-draft-2; this document says "1.0-draft", where it is "entities"']);
  const withFields = jsonOf(earlier);
  withFields.entities.A.fields = {};
  assert.deepEqual(validateModel(withFields), ['entity A: "fields" is a key of format 1.0-draft-2; this document says "1.0-draft", where it is "properties"']);
  const withRecord = jsonOf(earlier);
  withRecord.entities.A.properties.b = { record: 'A' };
  assert.deepEqual(validateModel(withRecord), ['A.b: "record" is a key of format 1.0-draft-2; this document says "1.0-draft", where it is "entity"', 'A.b must have exactly one of type, entity, component']);
});

test('an unknown or missing identifier is the only message', () => {
  const message = 'modelspec must be "1.0-draft-2" (or "1.0-draft", the earlier spelling)';
  assert.deepEqual(validateModel({ modelspec: '2.0', module: {} }), [message]);
  assert.deepEqual(validateModel({ module }), [message]);
  assert.deepEqual(validateModel([]), ['the JSON AST must be an object']);
  assert.deepEqual(validateModel(null), ['the JSON AST must be an object']);
});

test('removed and reserved JSON fields are refused by name', () => {
  for (const vocabulary of Object.values(vocabularies)) {
    assert.deepEqual(validateModel(jsonOf(vocabulary, { collections: {} })), ['the collections field was removed from ModelSpec (decision 0019)']);
    assert.deepEqual(validateModel(jsonOf(vocabulary, { recordsets: {} })), ['the recordsets field was removed from ModelSpec (decision 0019)']);
    assert.deepEqual(validateModel(jsonOf(vocabulary, { projections: {} })), ['the projections field is reserved by ModelSpec and has no content (decision 0019); remove it']);
    assert.deepEqual(validateModel(jsonOf(vocabulary, { migrations: {} })), ['the migrations field is reserved by ModelSpec and has no content (decision 0019); remove it']);
  }
});

test('JSON structural checks name the vocabulary of the document', () => {
  for (const vocabulary of Object.values(vocabularies)) {
    const { record, field, records, fields } = vocabulary;
    const model = (change) => { const json = jsonOf(vocabulary); change(json); return validateModel(json); };
    assert.deepEqual(model((json) => { json.module = {}; }), ['module.id and module.version are required']);
    assert.deepEqual(model((json) => { json.module = 5; }), ['module must be an object']);
    assert.deepEqual(model((json) => { json[records].A.key = ['nope']; }), [`${record} A key nope is not a ${field}`]);
    assert.deepEqual(model((json) => { json[records].A.key = []; }), [`${record} A key must be a non-empty list when present`]);
    assert.deepEqual(model((json) => { json[records].A.key = ['id', 'id']; }), [`${record} A key id is duplicated`]);
    assert.deepEqual(model((json) => { json[records].A.key = [1]; }), [`${record} A key must be a list of ${field} names`]);
    assert.deepEqual(model((json) => { json[records].A.use = ['Missing']; }), [`${record} A references unknown component Missing`]);
    assert.deepEqual(model((json) => { json[records].A.use = 'C'; }), [`${record} A use must be a list of component names`]);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { [record]: 'Missing' }; }), [`A.b references unknown ${record} Missing`]);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { [record]: 'other.Module' }; }), [`A.b names ${record} other.Module of another module; the registry cannot resolve module-qualified references yet`]);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { type: 'string', [record]: 'A' }; }), [`A.b must have exactly one of type, ${record}, component`]);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { type: 'nope' }; }), ['A.b has unsupported type "nope"']);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { type: 'string', surprise: 1 }; }), ['A.b has unsupported attribute surprise']);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { type: 'string', max_len: -1 }; }), ['A.b.max_len must be a non-negative integer']);
    assert.deepEqual(model((json) => { json[records].A[fields].b = { enum: 'Missing' }; }), ['A.b must have exactly one of type, ' + record + ', component', 'A.b references unknown enum Missing']);
    assert.deepEqual(model((json) => { json[records].A[fields] = 5; }), [`${records} A must be an object with ${fields}`]);
    assert.deepEqual(model((json) => { json[records].A[fields].b = 5; }), ['A.b must be an object']);
    assert.deepEqual(model((json) => { json[records] = []; }), [`${records} must be an object keyed by name`]);
    assert.deepEqual(model((json) => { json.enums = { E: { values: [] } }; }), ['enum E needs a non-empty values list']);
    assert.deepEqual(model((json) => { json.enums = { E: { values: ['a', 'a'] } }; }), ['enum E has duplicate values']);
    assert.deepEqual(model((json) => { json.enums = { A: { values: ['a'] } }; }), [`A is declared as both ${records} and enums`, `A.b references unknown ${record} A`]);
    assert.deepEqual(model((json) => { json.enums = []; }), ['enums must be an object keyed by name']);
    assert.deepEqual(model((json) => { json.components.C.fields.x = { component: 'Missing' }; }), ['C.x references unknown component Missing']);
    assert.deepEqual(model((json) => { json[records]['a.b'] = { [fields]: {} }; }), ['a.b: concept names cannot contain dots']);
  }
});

test('the twin comparison: a source and a twin in the same vocabulary are compared member by member', () => {
  for (const hcl of [earlierHcl, currentHcl, mixedHcl]) {
    const source = toJson(hcl);
    assert.deepEqual(astDifferences(source, parseJson(serializeModel(source))), []);
  }
  const published = toJson(currentHcl);
  published.records.Invoice.fields.customer = { record: 'Invoice' };
  delete published.records.Customer.key;
  published.enums.Status.values = ['paid', 'open'];
  assert.deepEqual(astDifferences(toJson(currentHcl), published), [
    'enums.Status.values is ["open","paid"] in the HCL source but ["paid","open"] in the JSON AST',
    'records.Customer.key is in the HCL source but not in the JSON AST',
    'records.Invoice.fields.customer.record is "Customer" in the HCL source but "Invoice" in the JSON AST',
  ]);
});

test('the twin comparison: a twin in the other vocabulary is one clear difference, in both directions', () => {
  const hint = 'the two must be in the same vocabulary (modelspec rewrite --write brings the pair in line)';
  // current source, earlier twin
  assert.deepEqual(astDifferences(toJson(currentHcl), toJson(earlierHcl)), [`modelspec is "1.0-draft-2" in the HCL source but "1.0-draft" in the JSON AST; ${hint}`]);
  // earlier source, current twin
  assert.deepEqual(astDifferences(toJson(earlierHcl), toJson(currentHcl)), [`modelspec is "1.0-draft" in the HCL source but "1.0-draft-2" in the JSON AST; ${hint}`]);
  // a mixed source has an earlier twin; the current twin of the same model is the other vocabulary
  assert.deepEqual(astDifferences(toJson(mixedHcl), jsonOf(vocabularies.current)), [`modelspec is "1.0-draft" in the HCL source but "1.0-draft-2" in the JSON AST; ${hint}`]);
});

test('parseJson refuses duplicate names and keeps names such as __proto__', () => {
  assert.throws(() => parseJson('{"a":1,"a":2}'), /duplicate name "a" in the top-level object/);
  assert.deepEqual(Object.keys(parseJson('{"__proto__":{"constructor":1}}')), ['__proto__']);
});
