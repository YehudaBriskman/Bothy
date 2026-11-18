// Package install is `bothy install` / `bothy uninstall` for the Compose
// runtime: preflight, a printable plan, and an idempotent apply driven by a
// release manifest and a stack definition embedded in the binary.
//
// It is NOT reachable from the MCP server: internal/mcpserver must never import
// it (a test holds that, slice-1 rule).
package install

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"

	"github.com/YehudaBriskman/Bothy/cli/internal/stackgen"
)

//go:generate go run ../../cmd/stackgen -repo ../../.. -out .

// stackFS is the generated stack definition (see stack/modes.yml). `all:` so an
// empty-name or dot file is never silently left out of the binary.
//
//go:embed all:stack
var stackFS embed.FS

// Stack is one mode's embedded definition.
type Stack struct {
	Meta    stackgen.Meta
	Compose []byte
	Files   map[string][]byte // path under the stack dir -> content
}

// LoadStack returns the embedded definition of a mode ("mini").
func LoadStack(mode string) (*Stack, error) {
	return loadStack(stackFS, mode)
}

func loadStack(fsys fs.FS, mode string) (*Stack, error) {
	base := path.Join("stack", mode)
	mj, err := fs.ReadFile(fsys, base+"/stack.json")
	if err != nil {
		return nil, fmt.Errorf("this binary has no %q stack: %w", mode, err)
	}
	s := &Stack{Files: map[string][]byte{}}
	if err := json.Unmarshal(mj, &s.Meta); err != nil {
		return nil, fmt.Errorf("embedded stack.json: %w", err)
	}
	if s.Compose, err = fs.ReadFile(fsys, base+"/compose.yml.tmpl"); err != nil {
		return nil, err
	}
	for _, f := range s.Meta.Files {
		b, err := fs.ReadFile(fsys, base+"/files/"+f)
		if err != nil {
			return nil, err
		}
		s.Files[f] = b
	}
	return s, nil
}

// Modes lists the modes embedded in this binary.
func Modes() []string {
	ents, _ := fs.ReadDir(stackFS, "stack")
	var out []string
	for _, e := range ents {
		if e.IsDir() && e.Name()[0] != '_' { // _source is the module sources, not a mode
			out = append(out, e.Name())
		}
	}
	return out
}

// sourceFS is the embedded sources (stack/_source), shaped like the repo, so an
// installed box can generate the module set it actually runs.
func sourceFS() fs.FS {
	sub, err := fs.Sub(stackFS, "stack/_source")
	if err != nil {
		panic(err) // the path is a constant of the embed
	}
	return sub
}

// Catalogue is the module catalogue this binary carries (stack/modes.yml).
func Catalogue() (*stackgen.Modes, error) {
	return stackgen.Load(sourceFS())
}

// LoadStackSet generates the stack of a mode for a module set, from the
// embedded sources. nil names mean the mode's default set. Core modules and
// everything required are added; the result is deterministic.
func LoadStackSet(mode string, names []string) (*Stack, error) {
	ms, err := Catalogue()
	if err != nil {
		return nil, err
	}
	if _, ok := ms.Modes[mode]; !ok {
		return nil, fmt.Errorf("this binary has no %q stack", mode)
	}
	if names == nil {
		if names, err = ms.DefaultSet(mode); err != nil {
			return nil, err
		}
	}
	out, err := stackgen.GenSet(sourceFS(), ms, mode, names)
	if err != nil {
		return nil, err
	}
	return &Stack{Meta: out.Meta, Compose: out.Compose, Files: out.Files}, nil
}
