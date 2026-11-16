package catalogen

import (
	"bytes"
	"os"
	"testing"
)

const gen = "../../../apps/bothy-ops/generated/"

// The drift check (plan T1, decisions D41/D42): regenerating the tables from
// the catalog JSON must yield exactly the committed ops_gen.go. When it fails,
// run `go generate ./...` in cli/ and commit the result.
func TestOpsGenIsCurrent(t *testing.T) {
	v, err := os.ReadFile(gen + "cli-verbs.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	tl, err := os.ReadFile(gen + "mcp-tools.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	want, err := Render(v, tl)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile("../catalog/ops_gen.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("internal/catalog/ops_gen.go is stale: run `go generate ./...` in cli/ and commit it")
	}
}

func TestRenderRejectsOrphanTool(t *testing.T) {
	v := []byte(`{"api_version":1,"verbs":[]}`)
	tl := []byte(`{"api_version":1,"tools":[{"name":"x","operation":"nope","scope":"read","description":"d","inputSchema":{}}]}`)
	if _, err := Render(v, tl); err == nil {
		t.Fatal("expected an error for a tool whose operation has no verb")
	}
}
