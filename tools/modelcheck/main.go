// modelcheck validates source artifacts, never publisher code. Acquisition,
// provenance and immutable pin policy belong to the registry caller.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"
	"regexp"
	"sort"
	"strings"

	ms "github.com/modelspec-org/cli/pkg/modelspec"
)

type inputModule struct {
	Alias      string `json:"alias"`
	HCL        string `json:"hcl"`
	JSON       string `json:"json"`
	RevisionID string `json:"revision_id,omitempty"`
	HCLPath    string `json:"hcl_path,omitempty"`
	JSONPath   string `json:"json_path,omitempty"`
}
type request struct {
	Context string        `json:"context"`
	Modules []inputModule `json:"modules"`
}
type result struct {
	OK            bool            `json:"ok"`
	Findings      []ms.Finding    `json:"findings"`
	AST           json.RawMessage `json:"ast,omitempty"`
	ASTJSON       string          `json:"ast_json,omitempty"`
	LogicalDigest string          `json:"logical_digest,omitempty"`
	GraphJSON     string          `json:"graph_json,omitempty"`
}

func main() {
	var req request
	input, err := io.ReadAll(io.LimitReader(os.Stdin, (64<<20)+1))
	if err != nil || len(input) > 64<<20 {
		fail(fmt.Errorf("request exceeds 64 MiB or cannot be read"))
	}
	dec := json.NewDecoder(bytes.NewReader(input))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		fail(err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		fail(fmt.Errorf("expected one request"))
	}
	res := check(req)
	if err := json.NewEncoder(os.Stdout).Encode(res); err != nil {
		fail(err)
	}
	if !res.OK {
		os.Exit(1)
	}
}

func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(2) }

func check(req request) result {
	r := result{Findings: []ms.Finding{}}
	add := func(file, rule, msg string) {
		r.Findings = append(r.Findings, ms.Finding{File: file, Rule: rule, Severity: ms.SeverityError, Message: msg})
	}
	if req.Context != "authoring" && req.Context != "pinned-import" && req.Context != "attachment" {
		add("request", "context", "expected authoring, pinned-import or attachment")
		return r
	}
	if len(req.Modules) == 0 {
		add("request", "modules", "root module required")
		return r
	}
	if req.Modules[0].RevisionID != "" {
		if err := projectionPins(req.Modules); err != nil {
			add("request", "native-graph", err.Error())
			return r
		}
	}
	var models []*ms.Model
	var hclRoots []*ms.Model
	var roots []*ms.Model
	var normalized []*ms.Node
	hasUnpairedHCL := false
	aliases := map[string]bool{}
	for i, unit := range req.Modules {
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(unit.Alias) || aliases[unit.Alias] {
			add("request", "module-alias", "invalid or duplicate alias "+unit.Alias)
			continue
		}
		aliases[unit.Alias] = true
		hclFile, jsonFile := unit.Alias+ms.HCLSuffix, unit.Alias+ms.JSONSuffix
		if unit.HCLPath != "" {
			hclFile = unit.HCLPath
		}
		if unit.JSONPath != "" {
			jsonFile = unit.JSONPath
		}
		h, hf := ms.ParseHCL(hclFile, []byte(unit.HCL))
		if unit.JSON == "" && req.Context == "attachment" {
			h.Name, h.Group, h.ReferenceOnly = unit.Alias, unit.Alias, true
			r.Findings = append(r.Findings, hf...)
			models = append(models, h)
			hasUnpairedHCL = true
			continue
		}
		j, jf := ms.ParseJSON(jsonFile, []byte(unit.JSON))
		r.Findings = append(r.Findings, hf...)
		r.Findings = append(r.Findings, jf...)
		h.Name, h.Group = unit.Alias, unit.Alias
		j.Name, j.Group = unit.Alias, unit.Alias
		h.ReferenceOnly = req.Context != "authoring" || i > 0
		j.ReferenceOnly = h.ReferenceOnly
		j.Twin, j.TwinOf = true, h
		models = append(models, h, j)
		roots = append(roots, j)
		hclRoots = append(hclRoots, h)
		if j.Module == nil || j.Module.ID == "" || j.Module.Version == "" {
			add(j.File, "module", "module identity/version required")
			continue
		}
		if j.Module.Name != "" && j.Module.Name != unit.Alias {
			add(j.File, "module-alias", "locked alias differs from module.name")
			continue
		}
		exported, err := h.JSON(*j.Module)
		if err != nil {
			add(h.File, "export", err.Error())
			continue
		}
		if diff := ms.Diff(exported, j.Root); diff != "" {
			add(j.File, "source-twin", diff)
		}
		// The parsed model uses the current internal vocabulary. Export a copy
		// in current vocabulary for comparison only; keep original artifacts.
		copyH := *h
		copyH.Old = nil
		n, err := copyH.JSON(*j.Module)
		if err != nil {
			add(h.File, "native-projection", err.Error())
			continue
		}
		normalized = append(normalized, n)
	}
	r.Findings = append(r.Findings, ms.Check(models, ms.Options{Profile: ms.ProfileDefault})...)
	for i := range r.Findings {
		if r.Findings[i].Rule == ms.RuleUnknown || r.Findings[i].Rule == ms.RuleStaleTwin {
			r.Findings[i].Severity = ms.SeverityError
		}
		if r.Findings[i].Severity == ms.SeverityError {
			return r
		}
	}
	if hasUnpairedHCL {
		r.OK = true
		return r
	}
	if len(normalized) != len(req.Modules) || len(roots) != len(req.Modules) {
		add("request", "projection", "incomplete module closure")
		return r
	}
	seenIDs := map[string]string{}
	var table []string
	for i, n := range normalized {
		id := roots[i].Module.ID
		clone := *n
		clone.Fields = append([]ms.Field(nil), n.Fields...)
		for k, f := range clone.Fields {
			if f.Key == "module" {
				m := *f.Value
				m.Fields = nil
				for _, v := range f.Value.Fields {
					if v.Key != "version" {
						m.Fields = append(m.Fields, v)
					}
				}
				clone.Fields[k].Value = &m
			}
		}
		canonical, err := canonicalNode(&clone)
		if err != nil {
			add("request", "logical-digest", err.Error())
			return r
		}
		if old, ok := seenIDs[id]; ok && old != canonical {
			add("request", "module-identity", "conflicting logical module identity "+id)
			return r
		}
		seenIDs[id] = canonical
		// Alias is part of the lock binding, not a floating lookup.
		alias, _ := json.Marshal(req.Modules[i].Alias)
		table = append(table, `{"alias":`+string(alias)+`,"ast":`+canonical+`}`)
	}
	sort.Strings(table)
	root, _ := json.Marshal(roots[0].Module.ID)
	bytesToHash := []byte(`{"algorithm":"meaninggraph-logical-digest/v1","modules":[` + strings.Join(table, ",") + `],"root":` + string(root) + `}`)
	sum := sha256.Sum256(bytesToHash)
	if req.Modules[0].RevisionID != "" {
		graph, err := projectModelGraph(req.Modules, hclRoots, roots, normalized)
		if err != nil {
			add("request", "native-graph", err.Error())
			return r
		}
		r.GraphJSON = string(graph)
	}
	r.OK = true
	r.AST = json.RawMessage(normalized[0].Encode())
	r.ASTJSON = string(r.AST)
	r.LogicalDigest = "sha256:" + hex.EncodeToString(sum[:])
	return r
}

// canonicalNode preserves array order, sorts only object keys and retains exact
// decimal values instead of converting model constraints through float64.
func canonicalNode(n *ms.Node) (string, error) {
	switch n.Type {
	case ms.NodeObject:
		fields := append([]ms.Field(nil), n.Fields...)
		sort.Slice(fields, func(i, j int) bool { return fields[i].Key < fields[j].Key })
		out := make([]string, 0, len(fields))
		for _, f := range fields {
			k, _ := json.Marshal(f.Key)
			v, e := canonicalNode(f.Value)
			if e != nil {
				return "", e
			}
			out = append(out, string(k)+":"+v)
		}
		return "{" + strings.Join(out, ",") + "}", nil
	case ms.NodeArray:
		out := make([]string, 0, len(n.Items))
		for _, item := range n.Items {
			v, e := canonicalNode(item)
			if e != nil {
				return "", e
			}
			out = append(out, v)
		}
		return "[" + strings.Join(out, ",") + "]", nil
	case ms.NodeNumber:
		return decimal(n.Str)
	default:
		return string(bytes.TrimSpace(n.Encode())), nil
	}
}

func decimal(s string) (string, error) {
	parts := strings.Split(strings.ToLower(s), "e")
	exponent := new(big.Int)
	if len(parts) > 2 {
		return "", fmt.Errorf("invalid decimal")
	}
	if len(parts) == 2 {
		if _, ok := exponent.SetString(parts[1], 10); !ok {
			return "", fmt.Errorf("invalid exponent")
		}
	}
	base := parts[0]
	sign := ""
	if strings.HasPrefix(base, "-") {
		sign = "-"
		base = base[1:]
	}
	if dot := strings.IndexByte(base, '.'); dot >= 0 {
		exponent.Sub(exponent, big.NewInt(int64(len(base)-dot-1)))
		base = strings.Replace(base, ".", "", 1)
	}
	base = strings.TrimLeft(base, "0")
	if base == "" {
		return "0", nil
	}
	trimmed := strings.TrimRight(base, "0")
	exponent.Add(exponent, big.NewInt(int64(len(base)-len(trimmed))))
	return sign + trimmed + "e" + exponent.String(), nil
}
