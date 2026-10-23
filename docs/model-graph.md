# Typed model graph draft-1

Reviewed local preparation contract; no deployed API or production activation.

- graph_json is a JSON string containing meaninggraph-model-graph/draft-1 with
  root_revision_id, modules, nodes, edges, effective_fields, logical_record_sets.
- modules carries exact revision_id, alias (case retained), module_id/name/version,
  definition_ref equal to that exact revision_id. No full AST duplication.
- Nodes: DataModel, RecordType, Component, Enum, ModelField, Key, Constraint.
- Edges: contains, uses, record-reference, component-value, enum-reference,
  key-membership. Reference/key/use edges retain raw spelling and array positions;
  structural references retain explicit requiredness when present.
- LogicalRecordSet is a non-owning {record_type: canonical RecordType ID} view.
  There is no independent ID, owning node, or new HCL syntax.
- ID is compact encoding/json JSON of a string tuple, serialized as an ID string:
  ["meaninggraph-member/v1", revision_id, "DataModel"]
  ["meaninggraph-member/v1", revision_id, containingKind, containingName]
  ["meaninggraph-member/v1", revision_id, containingKind, containingName,
    "ModelField", fieldName]
  Key appends "Key" to its record tuple; Constraint appends "Constraint", attrName
  to its field tuple. Case, punctuation, and identity elements stay distinct.
- Every node/attribute/edge source has hcl {path,line if available}, json
  {path,line,pointer in original vocabulary}, ast {revision_id,pointer in normalized
  vocabulary}. Lines come from Concept/Member/Attr/Node; no byte/column/end ranges
  are invented. A DataModel has no single HCL declaration, so its HCL line is absent.
- Field attributes are all retained by AST pointer. Constraint nodes cover enum,
  required, unique, min_len, max_len, pattern, format. Enum values remain under
  their Enum node's values attribute pointer. Key points to the complete ordered
  key array; membership edges additionally carry positions and composition paths.
- Constraint values never pass through float64 or interface{}; resolve their
  exact revision's retained definition ast_json and normalized JSON pointer.
  Foreign definitions must be resolved by exact revision, never a selected/latest
  module. Root's complete normalized ast_json remains separately retained.
- Effective field views carry owner, name, declared_by (canonical declaration
  field ID), declaration_owner, origin_revision_id, actual declaration source,
  and embedding_path with exact uses reference, position, owner/target/source.
  Own fields suppress inherited same-name views. Multiple same-name inherited
  declarations remain separate provenance views: the checker only unions names,
  so this patch does not invent a precedence/winner. No canonical duplicate fields.
- Only record use composition contributes effective inherited fields. Nested
  component values and record references are finite declaration edges, never
  recursive flattened expansions. Reference-supported cycles remain accepted.


The empty AST pointer addresses the complete `definition.ast` document; all other
AST pointers are JSON Pointers within that exact revision's AST, not within the
definition envelope. An original JSON pointer addresses the archived source JSON
and retains that draft's vocabulary. IDs are opaque strings to consumers; do not
split them by punctuation or construct a new field identity for a composed view.

Projection order keeps the root module first, then sorts dependency modules by
exact revision ID. Reordering registry lock rows cannot change immutable graph
bytes. Declared arrays (key membership, enum values, uses and their positions)
retain source order. The AST and logical digest are independent of projection
array layout. An absent source line means the parser does not supply one; do not
infer a source span from it.

`tools/modelcheck/project_test.go` covers composed keys, inherited-name provenance,
own-field overrides, qualified references, recursive record/component values,
keyless records, exact numbers, historical JSON pointers and reordered locks.
The adapter is source-language validation/projection only; the registry caller
verifies source identity, artifact digests, immutable paths and complete locks.
