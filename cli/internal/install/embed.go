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
	if s.Compose, err = fs.ReadFile(fsys, base+"/compose.yml"); err != nil {
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
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out
}
