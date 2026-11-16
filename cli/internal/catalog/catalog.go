// Package catalog holds the operation tables the CLI and the MCP server are
// built from. The tables themselves (ops_gen.go) are GENERATED from the
// catalog JSON the Python side emits (apps/bothy-ops/generated/); nothing in
// this package is edited by hand when an operation is added, you regenerate.
//
//go:generate go run ../../cmd/catalogen -verbs ../../../apps/bothy-ops/generated/cli-verbs.v1.json -tools ../../../apps/bothy-ops/generated/mcp-tools.v1.json -out ops_gen.go
package catalog

import "strings"

// Param is one query parameter of an operation, from cli-verbs.v1.json.
type Param struct {
	Name     string
	Required bool
	Type     string // "string" or "integer"
	Pattern  string // full-match regexp, "" if none
	Enum     []string
	Default  string // informational, "" if none
	HasMin   bool
	Min      int
	HasMax   bool
	Max      int
	OneOf    string // params sharing a non-empty OneOf: give exactly one
}

// Op is one read operation: its CLI verb, its HTTP request, and its MCP tool.
type Op struct {
	ID          string // "update.plan"
	Method      string
	Path        string
	Role        string
	Verb        []string // CLI words, e.g. {"update", "plan"}
	Params      []Param
	Tool        string // MCP tool name, "" when the op has no tool (discover)
	Scope       string // MCP scope: "read" in slice 1
	Description string // MCP description from the catalog
	InputSchema string // MCP input schema, JSON text, verbatim from the catalog
}

// VerbString is the verb as typed: "update plan".
func (o Op) VerbString() string { return strings.Join(o.Verb, " ") }

// ByID returns the op with the given id.
func ByID(id string) (Op, bool) {
	for _, o := range Ops {
		if o.ID == id {
			return o, true
		}
	}
	return Op{}, false
}

// ByTool returns the op served by the given MCP tool name.
func ByTool(name string) (Op, bool) {
	for _, o := range Ops {
		if o.Tool != "" && o.Tool == name {
			return o, true
		}
	}
	return Op{}, false
}
