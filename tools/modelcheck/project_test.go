package main

import (
	"encoding/json"
	"strings"
	"testing"

	ms "github.com/modelspec-org/cli/pkg/modelspec"
)

func pinned(u inputModule, revision string) inputModule {
	u.RevisionID = revision
	u.HCLPath = "model/" + u.Alias + ".modelspec.hcl"
	u.JSONPath = "generated/" + u.Alias + ".modelspec.json"
	return u
}
func projection(t *testing.T, units ...inputModule) (result, modelGraph) {
	t.Helper()
	r := check(request{Context: "authoring", Modules: units})
	if !r.OK {
		t.Fatal(r.Findings)
	}
	var g modelGraph
	if err := json.Unmarshal([]byte(r.GraphJSON), &g); err != nil {
		t.Fatal(err, r.GraphJSON)
	}
	// Every declaration, attribute, reference and composition source links both
	// normalized AST and original JSON. The latter may use historical spelling.
	for _, n := range g.Nodes {
		checkSource(t, n.Source, units)
		for _, a := range n.Attributes {
			checkSource(t, a.Source, units)
		}
	}
	for _, e := range g.Edges {
		checkSource(t, e.Source, units)
	}
	return r, g
}
func checkSource(t *testing.T, src graphSource, units []inputModule) {
	t.Helper()
	for _, u := range units {
		if src.AST.RevisionID != u.RevisionID {
			continue
		}
		j, _ := ms.ParseJSON(u.JSONPath, []byte(u.JSON))
		if src.HCL.Path != u.HCLPath || src.JSON.Path != u.JSONPath || src.JSON.Line <= 0 {
			t.Fatalf("ungrounded source: %+v", src)
		}
		if nodeAt(j.Root, src.JSON.Pointer) == nil {
			t.Fatalf("original pointer missing: %+v", src)
		}
		h, _ := ms.ParseHCL(u.HCLPath, []byte(u.HCL))
		h.Name = u.Alias
		h.Old = nil
		n, err := h.JSON(*j.Module)
		if err != nil || nodeAt(n, src.AST.Pointer) == nil {
			t.Fatalf("normalized pointer missing: %+v %v", src, err)
		}
		return
	}
	t.Fatalf("unlocked source: %+v", src)
}
func nodesOf(g modelGraph, kind string) []graphNode {
	var result []graphNode
	for _, n := range g.Nodes {
		if n.Kind == kind {
			result = append(result, n)
		}
	}
	return result
}
func edgesOf(g modelGraph, kind string) []graphEdge {
	var result []graphEdge
	for _, e := range g.Edges {
		if e.Kind == kind {
			result = append(result, e)
		}
	}
	return result
}
func TestTypedGraphCompositionAndExactQualifiedReferences(t *testing.T) {
	root := pinned(fixture(t, "Orders", `record "Order" {
  use = ["Common.Identified"]
  key = ["id", "code"]
  field "code" { type = "string" }
  field "customer" {
    record = "Customers.Customer"
    required = true
  }
  field "address" { component = "Common.Address" }
  field "status" {
    type = "string"
    enum = "Common.Status"
  }
}
record "Keyless" {
  field "answer" { type = "int" }
}
`), strings.Repeat("a", 64))
	common := pinned(fixture(t, "Common", `component "Identified" {
  field "id" { type = "uuid" }
}
component "Address" {
  field "city" { type = "string" }
}
enum "Status" { values = ["open", "closed"] }
`), strings.Repeat("b", 64))
	customers := pinned(fixture(t, "Customers", `record "Customer" {
  field "id" { type = "uuid" }
}
`), strings.Repeat("c", 64))
	r, g := projection(t, root, common, customers)
	reordered, _ := projection(t, root, customers, common)
	if r.GraphJSON != reordered.GraphJSON || r.ASTJSON != reordered.ASTJSON || r.LogicalDigest != reordered.LogicalDigest {
		t.Fatal("dependency input order changed an immutable projection")
	}
	order := memberID(root.RevisionID, "RecordType", "Order")
	id := memberID(common.RevisionID, "Component", "Identified", "ModelField", "id")
	found := false
	for _, f := range g.EffectiveFields {
		if f.Owner == order && f.Name == "id" {
			found = true
			if f.DeclaredBy != id || f.OriginRevisionID != common.RevisionID || len(f.EmbeddingPath) != 1 || f.EmbeddingPath[0].Reference != "Common.Identified" || f.Source.HCL.Line != 2 || f.Source.HCL.Path != common.HCLPath {
				t.Fatalf("lost composition origin: %+v", f)
			}
		}
	}
	if !found {
		t.Fatal("missing component field")
	}
	keys := edgesOf(g, "key-membership")
	if len(keys) != 2 || keys[0].To != id || *keys[0].Position != 0 || *keys[1].Position != 1 || len(keys[0].EmbeddingPath) != 1 {
		t.Fatal(keys)
	}
	for kind, target := range map[string]string{"record-reference": memberID(customers.RevisionID, "RecordType", "Customer"), "component-value": memberID(common.RevisionID, "Component", "Address"), "enum-reference": memberID(common.RevisionID, "Enum", "Status")} {
		es := edgesOf(g, kind)
		if len(es) != 1 || es[0].To != target {
			t.Fatal(kind, es)
		}
		if kind == "record-reference" && (es[0].Required == nil || !*es[0].Required) {
			t.Fatal("lost reference requiredness", es)
		}
	}
	if len(nodesOf(g, "Key")) != 1 || len(g.LogicalRecordSets) != 3 || len(nodesOf(g, "LogicalRecordSet")) != 0 {
		t.Fatal("invented key or canonical recordset")
	}
	if len(nodesOf(g, "DataModel")) != 3 || len(nodesOf(g, "Component")) != 2 || len(nodesOf(g, "Enum")) != 1 {
		t.Fatal("wrong taxonomy")
	}
	// Projection must neither alter native AST/digest nor embed full AST copies.
	plainRoot, plainCommon, plainCustomers := root, common, customers
	plainRoot.RevisionID = ""
	plainCommon.RevisionID = ""
	plainCustomers.RevisionID = ""
	plain := check(request{Context: "authoring", Modules: []inputModule{plainRoot, plainCommon, plainCustomers}})
	if !plain.OK || plain.GraphJSON != "" || plain.ASTJSON != r.ASTJSON || plain.LogicalDigest != r.LogicalDigest {
		t.Fatal("projection changed AST or digest")
	}
	if strings.Contains(r.GraphJSON, "ast_json") || strings.Contains(r.GraphJSON, "\"latest\"") {
		t.Fatal("duplicated AST or floating target")
	}
	common.RevisionID = strings.Repeat("d", 64)
	_, newGraph := projection(t, root, common, customers)
	if edgesOf(newGraph, "component-value")[0].To == edgesOf(g, "component-value")[0].To {
		t.Fatal("foreign target did not bind exact supplied revision")
	}
}
func TestOwnOverrideAndInheritedCollisionsPreserveDeclarations(t *testing.T) {
	u := pinned(fixture(t, "overrides", `component "A" {
  field "id" { type = "uuid" }
  field "shared" { type = "string" }
}
component "B" {
  field "shared" { type = "int" }
}
record "Item" {
  use = ["A", "B"]
  key = ["id"]
  field "id" { type = "string" }
}
`), "revision")
	_, g := projection(t, u)
	owner := memberID(u.RevisionID, "RecordType", "Item")
	var id, shared int
	for _, f := range g.EffectiveFields {
		if f.Owner == owner {
			switch f.Name {
			case "id":
				id++
				if f.DeclaredBy != appendID(owner, "ModelField", "id") || len(f.EmbeddingPath) != 0 {
					t.Fatal("own override lost", f)
				}
			case "shared":
				shared++
				if len(f.EmbeddingPath) != 1 {
					t.Fatal(f)
				}
			}
		}
	}
	if id != 1 || shared != 2 || len(nodesOf(g, "ModelField")) != 4 {
		t.Fatal("lost origins or invented canonical declarations", id, shared, g.Nodes)
	}
	if edgesOf(g, "key-membership")[0].To != appendID(owner, "ModelField", "id") {
		t.Fatal("key ignored own override")
	}
}
func TestGraphConstraintsEnumsAndLosslessLargeNumbers(t *testing.T) {
	u := pinned(fixture(t, "constraints", `enum "Code" { values = [9007199254740993, 2] }
record "Item" {
  field "code" {
    type = "int"
    enum = "Code"
    required = true
    unique = false
    min_len = 1
    max_len = 9007199254740993
    pattern = "[0-9]+"
    format = "identifier"
  }
  field "literal" {
    type = "int"
    enum = [9007199254740993, 2]
  }
}
`), "constraints-revision")
	r, g := projection(t, u)
	if len(nodesOf(g, "Constraint")) != 8 {
		t.Fatalf("constraints lost: %+v", nodesOf(g, "Constraint"))
	}
	ast, err := ms.ParseNode([]byte(r.ASTJSON))
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, c := range nodesOf(g, "Constraint") {
		value := nodeAt(ast, c.Source.AST.Pointer)
		if value == nil {
			t.Fatal(c)
		}
		seen[c.Name] = true
		if c.Name == "max_len" && value.Str != "9007199254740993" {
			t.Fatal("constraint rounded", value.Str)
		}
		if c.Name == "enum" && value.Type == ms.NodeArray && value.Items[0].Str != "9007199254740993" {
			t.Fatal("literal enum rounded")
		}
	}
	for _, name := range []string{"required", "unique", "min_len", "max_len", "pattern", "format", "enum"} {
		if !seen[name] {
			t.Fatal("missing constraint", name)
		}
	}
	if nodeAt(ast, "/enums/Code/values/0").Str != "9007199254740993" || r.ASTJSON != string(r.AST) {
		t.Fatal("native enum value rounded")
	}
	// JSON encoding to/from a JS string preserves the entire graph/AST envelope.
	envelope, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var restored result
	if err = json.Unmarshal(envelope, &restored); err != nil || restored.GraphJSON != r.GraphJSON || restored.ASTJSON != r.ASTJSON {
		t.Fatal("lossless envelope failed", err)
	}
}
func TestGraphRecordAndNestedComponentCyclesRemainFinite(t *testing.T) {
	u := pinned(fixture(t, "cycles", `component "A" {
  field "other" { component = "B" }
}
component "B" {
  field "other" { component = "A" }
}
record "X" {
  use = ["A"]
  field "next" { record = "Y" }
}
record "Y" {
  field "next" { record = "X" }
}
`), "cycles-revision")
	_, g := projection(t, u)
	if len(edgesOf(g, "component-value")) != 2 || len(edgesOf(g, "record-reference")) != 2 || len(nodesOf(g, "ModelField")) != 4 || len(g.EffectiveFields) != 5 {
		t.Fatal("recursive values were expanded or discarded", g)
	}
}
func TestGraphPinAndPathClosureRequiredOnlyWhenRequested(t *testing.T) {
	root := fixture(t, "root", `record "Item" {
  field "id" { type = "uuid" }
}
`)
	dep := fixture(t, "dep", `component "Value" {
  field "id" { type = "uuid" }
}
`)
	if r := check(request{Context: "authoring", Modules: []inputModule{root, dep}}); !r.OK || r.GraphJSON != "" {
		t.Fatal("basic adapter behavior changed", r)
	}
	root = pinned(root, "root-revision")
	if r := check(request{Context: "authoring", Modules: []inputModule{root, dep}}); r.OK {
		t.Fatal("unresolved dependency pin accepted")
	}
	dep = pinned(dep, "dep-revision")
	for _, bad := range []string{"", "../secret", "/absolute/file", "path/../file", "./file", "path\\file"} {
		badDep := dep
		badDep.HCLPath = bad
		if check(request{Context: "authoring", Modules: []inputModule{root, badDep}}).OK {
			t.Fatal("ungrounded path accepted", bad)
		}
	}
	badDep := dep
	badDep.RevisionID = root.RevisionID
	if check(request{Context: "authoring", Modules: []inputModule{root, badDep}}).OK {
		t.Fatal("duplicate revision accepted")
	}
	root.JSON = ""
	if check(request{Context: "attachment", Modules: []inputModule{root}}).OK {
		t.Fatal("registered graph invented for HCL-only attachment")
	}
}
func TestHistoricalProjectionLinksOriginalAndNormalizedPointers(t *testing.T) {
	u := pinned(fixture(t, "old", `entity "One/Two~Three" {
  key = ["Key/Name~"]
  property "Key/Name~" { type = "uuid" }
  property "next" { entity = "One/Two~Three" }
}
`), "old-revision")
	r := check(request{Context: "pinned-import", Modules: []inputModule{u}})
	if !r.OK {
		t.Fatal(r.Findings)
	}
	var g modelGraph
	if err := json.Unmarshal([]byte(r.GraphJSON), &g); err != nil {
		t.Fatal(err)
	}
	for _, n := range g.Nodes {
		checkSource(t, n.Source, []inputModule{u})
		for _, a := range n.Attributes {
			checkSource(t, a.Source, []inputModule{u})
		}
	}
	edge := edgesOf(g, "record-reference")[0]
	checkSource(t, edge.Source, []inputModule{u})
	if edge.Source.JSON.Pointer != "/entities/One~1Two~0Three/properties/next/entity" || edge.Source.AST.Pointer != "/records/One~1Two~0Three/fields/next/record" || edge.Source.HCL.Line != 4 {
		t.Fatal("wrong historical source map", edge.Source)
	}
	for _, f := range nodesOf(g, "ModelField") {
		if f.Name == "Key/Name~" && (f.Source.HCL.Line != 3 || f.Source.AST.Pointer != "/records/One~1Two~0Three/fields/Key~1Name~0") {
			t.Fatal("field source map lost", f)
		}
	}
	if memberID("revision", "RecordType", "x:y", "ModelField", "z") == memberID("revision", "RecordType", "x", "ModelField", "y:z") {
		t.Fatal("ambiguous declaration ID")
	}
}

func TestGraphUsesReferenceCheckerFailures(t *testing.T) {
	for _, src := range []string{
		"record \"Item\" {\n  use = [\"Missing\"]\n}\n",
		"record \"Item\" {\n  key = [\"missing\"]\n}\n",
		"record \"Item\" {\n  field \"other\" { record = \"unlocked.Target\" }\n}\n",
	} {
		u := pinned(fixture(t, "invalid", src), "invalid-revision")
		r := check(request{Context: "authoring", Modules: []inputModule{u}})
		if r.OK || r.GraphJSON != "" {
			t.Fatal("invalid reference semantics projected", r)
		}
		for _, f := range r.Findings {
			if f.Rule == "native-graph" {
				t.Fatal("projection replaced reference validator", r.Findings)
			}
		}
	}
}
