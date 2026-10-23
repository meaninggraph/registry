package main

import (
	"encoding/json"
	"strings"
	"testing"

	ms "github.com/modelspec-org/cli/pkg/modelspec"
)

func fixture(t *testing.T, alias, src string) inputModule {
	t.Helper()
	m, findings := ms.ParseHCL(alias+ms.HCLSuffix, []byte(src))
	if len(findings) != 0 {
		t.Fatal(findings)
	}
	m.Name = alias
	n, err := m.JSON(ms.ModuleIdentity{ID: "github.com/test/" + alias, Name: alias, Version: "0.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	return inputModule{Alias: alias, HCL: src, JSON: string(n.Encode())}
}

const composed = `component "Identified" {
  field "id" { type = "uuid" }
}
component "Address" {
  field "city" { type = "string" }
}
enum "Status" { values = ["open", "closed"] }
record "Item" {
  use = ["Identified"]
  key = ["id"]
  field "address" { component = "Address" }
  field "status" {
    type = "string"
    enum = "Status"
    required = true
    unique = true
    min_len = 1
    max_len = 16
    pattern = "[a-z]+"
    format = "identifier"
  }
}
record "Result" {
  field "value" { type = "string" }
}
`

func TestFullLanguageAndProjection(t *testing.T) {
	u := fixture(t, "inventory", composed)
	r := check(request{Context: "authoring", Modules: []inputModule{u}})
	if !r.OK {
		t.Fatal(r.Findings)
	}
	for _, text := range []string{`"components"`, `"enums"`, `"component": "Address"`, `"min_len": 1`, `"max_len": 16`, `"pattern": "[a-z]+"`, `"unique": true`, `"use"`} {
		if !strings.Contains(string(r.AST), text) {
			t.Errorf("native AST lost %s: %s", text, r.AST)
		}
	}
	var ast map[string]any
	if err := json.Unmarshal(r.AST, &ast); err != nil {
		t.Fatal(err)
	}
	result := ast["records"].(map[string]any)["Result"].(map[string]any)
	if _, ok := result["key"]; ok {
		t.Fatal("invented a key for a keyless record")
	}
}

func TestHistoricalSpellingAndAuthoringAreDifferent(t *testing.T) {
	u := fixture(t, "old", `entity "Item" {
  key = ["id"]
  property "id" { type = "uuid" }
}
`)
	if r := check(request{Context: "authoring", Modules: []inputModule{u}}); r.OK {
		t.Fatal("old authoring accepted")
	}
	r := check(request{Context: "pinned-import", Modules: []inputModule{u}})
	if !r.OK {
		t.Fatal(r.Findings)
	}
	if !strings.Contains(string(r.AST), `"records"`) || strings.Contains(string(r.AST), `"entities"`) {
		t.Fatal("comparison AST was not normalized", string(r.AST))
	}
}

func TestQualifiedReferencesUseExplicitClosure(t *testing.T) {
	root := fixture(t, "orders", `record "Order" {
  use = ["common.Identified"]
  key = ["id"]
  field "customer" { record = "customers.Customer" }
  field "address" { component = "common.Address" }
  field "status" {
    type = "string"
    enum = "common.Status"
  }
}
`)
	common := fixture(t, "common", `component "Identified" {
  field "id" { type = "uuid" }
}
component "Address" {
  field "city" { type = "string" }
}
enum "Status" { values = ["open", "closed"] }
`)
	customers := fixture(t, "customers", `record "Customer" {
  field "id" { type = "uuid" }
}
`)
	if r := check(request{Context: "authoring", Modules: []inputModule{root}}); r.OK {
		t.Fatal("unlocked modules resolved")
	}
	if r := check(request{Context: "authoring", Modules: []inputModule{root, common, customers}}); !r.OK {
		t.Fatal(r.Findings)
	}
}

func TestInvalidKeysAndTamperedTwinsFail(t *testing.T) {
	u := fixture(t, "inventory", strings.Replace(composed, `key = ["id"]`, `key = ["missing"]`, 1))
	if r := check(request{Context: "authoring", Modules: []inputModule{u}}); r.OK {
		t.Fatal("nonexistent key accepted")
	}
	u = fixture(t, "inventory", composed)
	u.JSON = strings.Replace(u.JSON, `"max_len": 16`, `"max_len": 17`, 1)
	if r := check(request{Context: "authoring", Modules: []inputModule{u}}); r.OK {
		t.Fatal("tampered twin accepted")
	}
}

func TestDecimalCanonicalizationIsLossless(t *testing.T) {
	for in, want := range map[string]string{"1": "1e0", "1.0": "1e0", "1e0": "1e0", "-0.0": "0", "1200": "12e2", "0.00120": "12e-4", "9007199254740993": "9007199254740993e0", "1.20e100": "12e99"} {
		got, err := decimal(in)
		if err != nil || got != want {
			t.Errorf("%s: %s %v, want %s", in, got, err, want)
		}
	}
}

func TestNativeEnvelopePreservesLargeNumericValues(t *testing.T) {
	u := fixture(t, "large", `enum "Code" { values = [9007199254740993] }
record "Item" {
  field "code" {
    type = "int"
    enum = "Code"
  }
}


`)
	r := check(request{Context: "authoring", Modules: []inputModule{u}})
	if !r.OK || r.ASTJSON != string(r.AST) || !strings.Contains(r.ASTJSON, "9007199254740993") {
		t.Fatal("large numeric value lost in native envelope", r.Findings, r.ASTJSON)
	}
}

func TestUnregisteredHCLAttachmentDoesNotInventModuleMetadata(t *testing.T) {
	u := inputModule{Alias: "standalone", HCL: `record "Item" {
  field "id" { type = "uuid" }
}
`}
	r := check(request{Context: "attachment", Modules: []inputModule{u}})
	if !r.OK || len(r.AST) != 0 || r.LogicalDigest != "" {
		t.Fatal("HCL attachment must validate without becoming a registered model", r)
	}
	if check(request{Context: "authoring", Modules: []inputModule{u}}).OK {
		t.Fatal("native registration accepted a missing JSON twin")
	}
	u.HCL = strings.Replace(u.HCL, `type = "uuid"`, `record = "Missing"`, 1)
	if check(request{Context: "attachment", Modules: []inputModule{u}}).OK {
		t.Fatal("invalid HCL attachment was accepted")
	}
}

func TestRecursiveReferencesAreFiniteAndMissingComponentsAreRejected(t *testing.T) {
	a := fixture(t, "a", `record "A" {
  field "other" { record = "b.B" }
}
`)
	b := fixture(t, "b", `record "B" {
  field "other" { record = "a.A" }
}
`)
	if r := check(request{Context: "authoring", Modules: []inputModule{a, b}}); !r.OK {
		t.Fatal("legal record reference cycle rejected", r.Findings)
	}
	recursive := fixture(t, "recursive", `component "A" {
  field "other" { component = "B" }
}
component "B" {
  field "other" { component = "A" }
}
record "Item" {
  use = ["A"]
}
`)
	if r := check(request{Context: "authoring", Modules: []inputModule{recursive}}); !r.OK {
		t.Fatal("reference-validator-supported nested recursion rejected", r.Findings)
	}
	u := fixture(t, "bad", `record "Item" {
  use = ["Missing"]
}
`)
	if check(request{Context: "authoring", Modules: []inputModule{u}}).OK {
		t.Fatal("missing component was accepted")
	}
}

func TestDigestIgnoresCommentsAndVersionButNotConstraints(t *testing.T) {
	u := fixture(t, "inventory", composed)
	a := check(request{Context: "authoring", Modules: []inputModule{u}})
	u.HCL = "# comment\n" + u.HCL
	u.JSON = strings.Replace(u.JSON, `"version": "0.1.0"`, `"version": "0.2.0"`, 1)
	b := check(request{Context: "authoring", Modules: []inputModule{u}})
	if !a.OK || !b.OK || a.LogicalDigest != b.LogicalDigest {
		t.Fatal("nonstructural change altered logical digest", a, b)
	}
	u = fixture(t, "inventory", strings.Replace(composed, "max_len = 16", "max_len = 17", 1))
	c := check(request{Context: "authoring", Modules: []inputModule{u}})
	if !c.OK || a.LogicalDigest == c.LogicalDigest {
		t.Fatal("constraint change did not change logical digest", c.Findings)
	}
}
