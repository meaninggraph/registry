package main

import (
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"

	ms "github.com/modelspec-org/cli/pkg/modelspec"
)

// The graph is a view over validated declarations, not another AST or grammar.
// Every attribute value remains at its exact revision's normalized AST pointer.
// Definition consumers must resolve foreign pointers through that revision's
// retained definition, never the currently selected module or a floating alias.
type modelGraph struct {
	Format            string             `json:"format"`
	RootRevisionID    string             `json:"root_revision_id"`
	Modules           []graphModule      `json:"modules"`
	Nodes             []graphNode        `json:"nodes"`
	Edges             []graphEdge        `json:"edges"`
	EffectiveFields   []effectiveField   `json:"effective_fields"`
	LogicalRecordSets []logicalRecordSet `json:"logical_record_sets"`
}
type graphModule struct {
	RevisionID    string `json:"revision_id"`
	Alias         string `json:"alias"`
	ModuleID      string `json:"module_id"`
	ModuleName    string `json:"module_name,omitempty"`
	Version       string `json:"version"`
	DefinitionRef string `json:"definition_ref"` // exact revision, not a URL
}
type astRef struct {
	RevisionID string `json:"revision_id"`
	Pointer    string `json:"pointer"`
}
type sourceLocation struct {
	Path string `json:"path"
	"sort"`
	Line    int    `json:"line,omitempty"`    // the parser exposes lines, not universal ranges
	Pointer string `json:"pointer,omitempty"` // original JSON vocabulary
}
type graphSource struct {
	HCL  sourceLocation `json:"hcl"`
	JSON sourceLocation `json:"json"`
	AST  astRef         `json:"ast"` // normalized AST vocabulary
}
type graphAttribute struct {
	Name   string      `json:"name"`
	Source graphSource `json:"source"`
}
type graphNode struct {
	ID         string           `json:"id"`
	Kind       string           `json:"kind"`
	RevisionID string           `json:"revision_id"`
	Name       string           `json:"name,omitempty"`
	Owner      string           `json:"owner,omitempty"`
	Source     graphSource      `json:"source"`
	Attributes []graphAttribute `json:"attributes,omitempty"`
}
type graphEdge struct {
	Kind          string          `json:"kind"`
	From          string          `json:"from"`
	To            string          `json:"to"`
	Reference     string          `json:"reference,omitempty"`
	Position      *int            `json:"position,omitempty"` // source array order, including zero
	Required      *bool           `json:"required,omitempty"`
	Source        graphSource     `json:"source"`
	EmbeddingPath []embeddingStep `json:"embedding_path,omitempty"`
}
type embeddingStep struct {
	Owner     string      `json:"owner"`
	Component string      `json:"component"`
	Reference string      `json:"reference"`
	Position  int         `json:"position"`
	Source    graphSource `json:"source"`
}
type effectiveField struct {
	Owner            string          `json:"owner"`
	Name             string          `json:"name"`
	DeclaredBy       string          `json:"declared_by"` // canonical ModelField declaration ID
	DeclarationOwner string          `json:"declaration_owner"`
	OriginRevisionID string          `json:"origin_revision_id"`
	Source           graphSource     `json:"source"`         // declaration's actual locations
	EmbeddingPath    []embeddingStep `json:"embedding_path"` // empty for own fields
}

// A LogicalRecordSet has no independent ID or owning node. It is a UI view of
// exactly one RecordType, without physical persistence or ordered-row semantics.
type logicalRecordSet struct {
	RecordType string `json:"record_type"`
}

// IDs are compact JSON-encoded tuples, serialized as strings. Kind and every
// case-sensitive name are independent elements, so punctuation cannot collide.
// Fields: [namespace, revision, containing kind, containing name, ModelField, name].
// Concepts: [namespace, revision, kind, name]; model: [namespace, revision, DataModel].
// Key/Constraint IDs append [Key] or [Constraint, attribute] to the owner's tuple.
func memberID(parts ...string) string {
	b, _ := json.Marshal(append([]string{"meaninggraph-member/v1"}, parts...))
	return string(b)
}
func appendID(id string, parts ...string) string {
	var tuple []string
	_ = json.Unmarshal([]byte(id), &tuple)
	b, _ := json.Marshal(append(tuple, parts...))
	return string(b)
}
func pointerPart(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
func projectionPins(units []inputModule) error {
	seen := map[string]bool{}
	for _, u := range units {
		if u.RevisionID == "" {
			return fmt.Errorf("module %q has no resolved revision_id", u.Alias)
		}
		if seen[u.RevisionID] {
			return fmt.Errorf("duplicate closure revision_id %q", u.RevisionID)
		}
		seen[u.RevisionID] = true
		for _, p := range []string{u.HCLPath, u.JSONPath} {
			if p == "" || p == "." || path.IsAbs(p) || path.Clean(p) != p || strings.ContainsAny(p, "\\\x00") || strings.HasPrefix(p, "../") {
				return fmt.Errorf("module %q requires actual repository-relative hcl_path and json_path", u.Alias)
			}
		}
		if u.HCLPath == u.JSONPath || u.JSON == "" {
			return fmt.Errorf("module %q requires its actual HCL/JSON artifact pair", u.Alias)
		}
	}
	return nil
}
func graphKind(k ms.Kind) string {
	switch k {
	case ms.KindRecord:
		return "RecordType"
	case ms.KindComponent:
		return "Component"
	default:
		return "Enum"
	}
}
func conceptPointer(c *ms.Concept, old bool) string {
	group := "enums"
	switch c.Kind {
	case ms.KindRecord:
		group = "records"
		if old {
			group = "entities"
		}
	case ms.KindComponent:
		group = "components"
	}
	return "/" + group + "/" + pointerPart(c.Name)
}
func fieldPointer(c *ms.Concept, name string, old bool) string {
	fields := "fields"
	if old && c.Kind == ms.KindRecord {
		fields = "properties"
	}
	return conceptPointer(c, old) + "/" + fields + "/" + pointerPart(name)
}
func findConcept(m *ms.Model, kind ms.Kind, name string) *ms.Concept {
	for _, c := range m.Concepts {
		if c.Kind == kind && c.Name == name {
			return c
		}
	}
	return nil
}
func findMember(c *ms.Concept, name string) *ms.Member {
	for i := range c.Members {
		if c.Members[i].Name == name {
			return &c.Members[i]
		}
	}
	return nil
}
func sourceFor(u inputModule, hLine, jLine int, normalized, original string) graphSource {
	return graphSource{HCL: sourceLocation{Path: u.HCLPath, Line: hLine}, JSON: sourceLocation{Path: u.JSONPath, Line: jLine, Pointer: original}, AST: astRef{RevisionID: u.RevisionID, Pointer: normalized}}
}
func attributeSource(u inputModule, h, j ms.Attr, normalized, original string, old bool) graphSource {
	origName := j.Name
	if old && origName == "record" {
		origName = "entity"
	}
	return sourceFor(u, h.Line, j.Line, normalized+"/"+pointerPart(h.Name), original+"/"+pointerPart(origName))
}

type projectedConcept struct {
	unit    int
	concept *ms.Concept
	id      string
	fields  []effectiveField
}

// projectModelGraph runs only after ParseHCL/ParseJSON, twin equality, and
// ProfileDefault succeed. It follows only declared use edges, not nested values.
func projectModelGraph(units []inputModule, hcl, parsed []*ms.Model, normalized []*ms.Node) ([]byte, error) {
	if err := projectionPins(units); err != nil {
		return nil, err
	}
	// Lock-row order is registry metadata, not part of an immutable model.
	// Keep the root first; sort foreign revisions without changing source arrays.
	order := make([]int, len(units)-1)
	for i := range order {
		order[i] = i + 1
	}
	sort.Slice(order, func(i, j int) bool { return units[order[i]].RevisionID < units[order[j]].RevisionID })
	order = append([]int{0}, order...)
	sortedUnits := make([]inputModule, len(units))
	sortedHCL, sortedParsed := make([]*ms.Model, len(units)), make([]*ms.Model, len(units))
	sortedNormalized := make([]*ms.Node, len(units))
	for i, j := range order {
		sortedUnits[i], sortedHCL[i], sortedParsed[i], sortedNormalized[i] = units[j], hcl[j], parsed[j], normalized[j]
	}
	units, hcl, parsed, normalized = sortedUnits, sortedHCL, sortedParsed, sortedNormalized
	g := modelGraph{Format: "meaninggraph-model-graph/draft-1", RootRevisionID: units[0].RevisionID, Modules: []graphModule{}, Nodes: []graphNode{}, Edges: []graphEdge{}, EffectiveFields: []effectiveField{}, LogicalRecordSets: []logicalRecordSet{}}
	aliases := map[string]int{}
	concepts := map[string]*projectedConcept{}
	var ordered []*projectedConcept
	for i, u := range units {
		aliases[u.Alias] = i
		m := parsed[i].Module
		g.Modules = append(g.Modules, graphModule{RevisionID: u.RevisionID, Alias: u.Alias, ModuleID: m.ID, ModuleName: m.Name, Version: m.Version, DefinitionRef: u.RevisionID})
		modelID := memberID(u.RevisionID, "DataModel")
		g.Nodes = append(g.Nodes, graphNode{ID: modelID, Kind: "DataModel", RevisionID: u.RevisionID, Name: m.ID, Source: sourceFor(u, 0, parsed[i].Root.Line, "", "")})
		for _, c := range hcl[i].Concepts {
			jc := findConcept(parsed[i], c.Kind, c.Name)
			if jc == nil {
				return nil, fmt.Errorf("validated twin has no %s %q", c.Kind, c.Name)
			}
			id := memberID(u.RevisionID, graphKind(c.Kind), c.Name)
			pc := &projectedConcept{unit: i, concept: c, id: id}
			concepts[id], ordered = pc, append(ordered, pc)
			ptr, orig := conceptPointer(c, false), conceptPointer(c, parsed[i].OldVocabulary())
			src := sourceFor(u, c.Line, jc.Line, ptr, orig)
			node := graphNode{ID: id, Kind: graphKind(c.Kind), RevisionID: u.RevisionID, Name: c.Name, Owner: modelID, Source: src}
			for _, a := range c.Attrs {
				ja, ok := jc.Attr(a.Name)
				if !ok {
					return nil, fmt.Errorf("missing twin attribute %s", a.Name)
				}
				node.Attributes = append(node.Attributes, graphAttribute{Name: a.Name, Source: attributeSource(u, a, *ja, ptr, orig, parsed[i].OldVocabulary())})
			}
			g.Nodes = append(g.Nodes, node)
			g.Edges = append(g.Edges, graphEdge{Kind: "contains", From: modelID, To: id, Source: src})
			if c.Kind == ms.KindRecord {
				g.LogicalRecordSets = append(g.LogicalRecordSets, logicalRecordSet{RecordType: id})
			}
			for _, f := range c.Members {
				jf := findMember(jc, f.Name)
				if jf == nil {
					return nil, fmt.Errorf("missing twin field %s", f.Name)
				}
				fid := appendID(id, "ModelField", f.Name)
				fp, fo := fieldPointer(c, f.Name, false), fieldPointer(c, f.Name, parsed[i].OldVocabulary())
				fs := sourceFor(u, f.Line, jf.Line, fp, fo)
				fn := graphNode{ID: fid, Kind: "ModelField", RevisionID: u.RevisionID, Name: f.Name, Owner: id, Source: fs}
				for _, a := range f.Attrs {
					ja, ok := jf.Attr(a.Name)
					if !ok {
						return nil, fmt.Errorf("missing twin field attribute %s", a.Name)
					}
					as := attributeSource(u, a, *ja, fp, fo, parsed[i].OldVocabulary())
					fn.Attributes = append(fn.Attributes, graphAttribute{Name: a.Name, Source: as})
					switch a.Name {
					case "type", "record", "component":
					default:
						cid := appendID(fid, "Constraint", a.Name)
						g.Nodes = append(g.Nodes, graphNode{ID: cid, Kind: "Constraint", RevisionID: u.RevisionID, Name: a.Name, Owner: fid, Source: as})
						g.Edges = append(g.Edges, graphEdge{Kind: "contains", From: fid, To: cid, Source: as})
					}
				}
				g.Nodes = append(g.Nodes, fn)
				g.Edges = append(g.Edges, graphEdge{Kind: "contains", From: id, To: fid, Source: fs})
				pc.fields = append(pc.fields, effectiveField{Owner: id, Name: f.Name, DeclaredBy: fid, DeclarationOwner: id, OriginRevisionID: u.RevisionID, Source: fs, EmbeddingPath: []embeddingStep{}})
			}
		}
	}
	// Resolve the same exact alias/name split used by the reference checker. No
	// network acquisition, version guessing, normalization, or latest fallback.
	resolve := func(unit int, ref string, kind ms.Kind) (*projectedConcept, error) {
		target, name := unit, ref
		if alias, qualified, ok := strings.Cut(ref, "."); ok {
			var exists bool
			target, exists = aliases[alias]
			if !exists {
				return nil, fmt.Errorf("unlocked module %q", alias)
			}
			name = qualified
		}
		c := concepts[memberID(units[target].RevisionID, graphKind(kind), name)]
		if c == nil {
			return nil, fmt.Errorf("unresolved validated %s reference %q", kind, ref)
		}
		return c, nil
	}
	for _, pc := range ordered {
		u, c := units[pc.unit], pc.concept
		jc := findConcept(parsed[pc.unit], c.Kind, c.Name)
		old := parsed[pc.unit].OldVocabulary()
		ptr, orig := conceptPointer(c, false), conceptPointer(c, old)
		effective := append([]effectiveField(nil), pc.fields...)
		own := map[string]bool{}
		for _, f := range pc.fields {
			own[f.Name] = true
		}
		if use, ok := c.Attr("use"); ok {
			ju, _ := jc.Attr("use")
			for pos, item := range use.Value.Items {
				target, err := resolve(pc.unit, item.Str, ms.KindComponent)
				if err != nil {
					return nil, err
				}
				src := attributeSource(u, *use, *ju, ptr, orig, old)
				src.AST.Pointer += "/" + strconv.Itoa(pos)
				src.JSON.Pointer += "/" + strconv.Itoa(pos)
				// Attr.Line is reliable for HCL; HCL list item Node.Line is the
				// attribute line, so no more precise item line is claimed.
				src.JSON.Line = ju.Value.Items[pos].Line
				position := pos
				g.Edges = append(g.Edges, graphEdge{Kind: "uses", From: pc.id, To: target.id, Reference: item.Str, Position: &position, Source: src})
				for _, f := range target.fields {
					if own[f.Name] {
						continue
					}
					f.Owner = pc.id
					f.EmbeddingPath = []embeddingStep{{Owner: pc.id, Component: target.id, Reference: item.Str, Position: pos, Source: src}}
					effective = append(effective, f)
				}
			}
		}
		g.EffectiveFields = append(g.EffectiveFields, effective...)
		if key, ok := c.Attr("key"); ok {
			jk, _ := jc.Attr("key")
			src := attributeSource(u, *key, *jk, ptr, orig, old)
			kid := appendID(pc.id, "Key")
			g.Nodes = append(g.Nodes, graphNode{ID: kid, Kind: "Key", RevisionID: u.RevisionID, Name: "key", Owner: pc.id, Source: src})
			g.Edges = append(g.Edges, graphEdge{Kind: "contains", From: pc.id, To: kid, Source: src})
			for pos, item := range key.Value.Items {
				for _, f := range effective {
					if f.Name == item.Str {
						position := pos
						ks := src
						ks.AST.Pointer += "/" + strconv.Itoa(pos)
						ks.JSON.Pointer += "/" + strconv.Itoa(pos)
						ks.JSON.Line = jk.Value.Items[pos].Line
						g.Edges = append(g.Edges, graphEdge{Kind: "key-membership", From: kid, To: f.DeclaredBy, Reference: item.Str, Position: &position, Source: ks, EmbeddingPath: f.EmbeddingPath})
					}
				}
			}
		}
		for _, f := range c.Members {
			jf := findMember(jc, f.Name)
			for _, ref := range []struct {
				attr, edge string
				kind       ms.Kind
			}{{"record", "record-reference", ms.KindRecord}, {"component", "component-value", ms.KindComponent}, {"enum", "enum-reference", ms.KindEnum}} {
				a, ok := f.Attr(ref.attr)
				if !ok || a.Value.Type != ms.NodeString {
					continue
				}
				target, err := resolve(pc.unit, a.Value.Str, ref.kind)
				if err != nil {
					return nil, err
				}
				ja, _ := jf.Attr(a.Name)
				src := attributeSource(u, *a, *ja, fieldPointer(c, f.Name, false), fieldPointer(c, f.Name, old), old)
				edge := graphEdge{Kind: ref.edge, From: appendID(pc.id, "ModelField", f.Name), To: target.id, Reference: a.Value.Str, Source: src}
				if required, ok := f.Attr("required"); ok {
					v := required.Value.Bool
					edge.Required = &v
				}
				g.Edges = append(g.Edges, edge)
			}
		}
	}
	// Verify linkage against the actual normalized AST without decoding through
	// interface{} (which would lose integer/decimal precision).
	for _, n := range g.Nodes {
		i := -1
		for j, u := range units {
			if u.RevisionID == n.RevisionID {
				i = j
				break
			}
		}
		if i < 0 || nodeAt(normalized[i], n.Source.AST.Pointer) == nil {
			return nil, fmt.Errorf("missing normalized AST pointer %s", n.Source.AST.Pointer)
		}
	}
	return json.Marshal(g)
}
func nodeAt(n *ms.Node, pointer string) *ms.Node {
	if pointer == "" {
		return n
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil
	}
	for _, part := range strings.Split(pointer[1:], "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		switch n.Type {
		case ms.NodeObject:
			var ok bool
			n, ok = n.Get(part)
			if !ok {
				return nil
			}
		case ms.NodeArray:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(n.Items) {
				return nil
			}
			n = n.Items[i]
		default:
			return nil
		}
	}
	return n
}
