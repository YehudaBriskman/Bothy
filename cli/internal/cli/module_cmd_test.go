package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
)

// The host-only module verbs have no catalog op, so no HTTP route and no MCP tool.
// (`module list` IS a catalog op, the remote one; the local list is the same words.)
func TestModuleChangeVerbsAreNotInTheCatalog(t *testing.T) {
	for _, op := range catalog.Ops {
		if len(op.Verb) >= 2 && op.Verb[0] == "module" && op.Verb[1] != "list" && op.Verb[1] != "config" {
			// any other module verb in the catalog must be a read
			if op.Scope != "read" {
				t.Errorf("catalog op %s (%v) is a %s on modules", op.ID, op.Verb, op.Scope)
			}
		}
		for _, w := range []string{"add", "remove", "rollback"} {
			if len(op.Verb) == 2 && op.Verb[0] == "module" && op.Verb[1] == w {
				t.Errorf("module %s is in the catalog (%s)", w, op.ID)
			}
		}
		if strings.Contains(op.Tool, "module_add") || strings.Contains(op.Tool, "module_remove") {
			t.Errorf("MCP tool %s exists", op.Tool)
		}
	}
}

func modIO(home string, out, errb *strings.Builder) IO {
	return IO{In: strings.NewReader(""), Out: out, Err: errb, Version: "2026.11.2",
		Getenv: func(k string) string {
			if k == "HOME" {
				return home
			}
			return ""
		}}
}

func TestModuleListLocalWhenAReceiptExists(t *testing.T) {
	home := t.TempDir()
	root := filepath.Join(home, "x", "bothy")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// --local without any receipt: shows the catalogue and says nothing is installed
	var out, errb strings.Builder
	code := Run([]string{"module", "list", "--local", "--root", root}, modIO(home, &out, &errb))
	if code != 0 || !strings.Contains(out.String(), "node-metrics") || !strings.Contains(out.String(), "nothing is installed") {
		t.Fatalf("code %d out %q err %q", code, out.String(), errb.String())
	}
	out.Reset()
	if code := Run([]string{"--json", "module", "list", "--local", "--root", root}, modIO(home, &out, &errb)); code != 0 || !strings.Contains(out.String(), `"memory_mib": 64`) {
		t.Fatalf("json: %d %q", code, out.String())
	}
	// add with nothing installed is a plain refusal, not a network call
	out.Reset()
	errb.Reset()
	code = Run([]string{"module", "add", "node-metrics", "--root", root, "--config-dir", filepath.Join(home, "c", "bothy")}, modIO(home, &out, &errb))
	if code == 0 || !strings.Contains(errb.String(), "nothing is installed") {
		t.Fatalf("code %d err %q", code, errb.String())
	}
	// wrong arity
	errb.Reset()
	if code := Run([]string{"module", "add", "--root", root}, modIO(home, &out, &errb)); code != 64 {
		t.Errorf("add without a name: %d %q", code, errb.String())
	}
}
