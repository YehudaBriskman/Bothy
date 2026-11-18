package stackgen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The golden of the real repo's mini + node-metrics set: the compose file and the
// routes. Regenerate with UPDATE_GOLDEN=1 go test ./internal/stackgen and review the diff.
func TestModuleSetGolden(t *testing.T) {
	fsys := os.DirFS(repoRoot)
	ms, err := Load(fsys)
	if err != nil {
		t.Fatal(err)
	}
	set, err := GenSet(fsys, ms, "mini", []string{"edge", "web", "files", "node-metrics"})
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string][]byte{
		"mini-node-metrics.compose.golden.yml": set.Compose,
		"mini-node-metrics.routes.golden.yml":  set.Files["traefik/dynamic/routes.yml"],
	} {
		golden := filepath.Join("testdata", name)
		if os.Getenv("UPDATE_GOLDEN") != "" {
			_ = os.MkdirAll("testdata", 0o755)
			if err := os.WriteFile(golden, got, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		want, err := os.ReadFile(golden)
		if err != nil {
			t.Fatal(err)
		}
		if string(want) != string(got) {
			t.Errorf("%s differs (UPDATE_GOLDEN=1 to accept):\n%s", golden, got)
		}
	}
	var mm *ModuleMeta
	for i := range set.Meta.Modules {
		if set.Meta.Modules[i].Name == "node-metrics" {
			mm = &set.Meta.Modules[i]
		}
	}
	if mm == nil || mm.MemMiB != 64 || len(mm.Services) != 1 || set.Meta.Schema != SchemaVersion {
		t.Errorf("module meta: %+v", mm)
	}
	if len(set.Meta.Verify.HTTP) != 1 || set.Meta.Verify.HTTP[0].Path != "/-/api/node/metrics" {
		t.Errorf("verify: %+v", set.Meta.Verify)
	}
}

// Subsets: the core alone, and each module alone, are valid stacks; a module not
// in the set leaves nothing behind.
func TestEverySubsetIsValid(t *testing.T) {
	fsys := os.DirFS(repoRoot)
	ms, _ := Load(fsys)
	core, err := GenSet(fsys, ms, "mini", nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(core.Compose), "bothy-files") || strings.Contains(string(core.Compose), "node-exporter") {
		t.Error("the core set carries an optional module")
	}
	for _, n := range ms.ModuleNames() {
		if _, err := GenSet(fsys, ms, "mini", []string{n}); err != nil {
			t.Errorf("module %s alone: %v", n, err)
		}
	}
}

const catalogue = `schema: 2
modes:
  t: {title: T, project: p, reserve_mib: 1}
modules:
  a: {compose: a/compose.yml, services: [a], memory_mib: 10, core: true, modes: [t], provides: [cap], health: {http: [{path: /, contains: x}]}}
  b: {compose: a/compose.yml, services: [b], memory_mib: 10, requires: [cap], health: {http: [{path: /, contains: x}]}}
  c: {compose: a/compose.yml, services: [c], memory_mib: 10, requires: [b], health: {http: [{path: /, contains: x}]}}
`

func TestClosureDependantsAndCycles(t *testing.T) {
	ms, err := Parse([]byte(catalogue))
	if err != nil {
		t.Fatal(err)
	}
	set, err := ms.Closure([]string{"c"})
	if err != nil || strings.Join(set, ",") != "a,b,c" { // b through c, a through b's capability
		t.Fatalf("closure: %v %v", set, err)
	}
	if d := ms.Dependants([]string{"a", "b", "c"}, "b"); strings.Join(d, ",") != "c" {
		t.Errorf("dependants of b: %v", d)
	}
	if d := ms.Dependants([]string{"a", "b", "c"}, "a"); strings.Join(d, ",") != "b" { // c is still satisfied by b
		t.Errorf("dependants of a: %v", d)
	}
	if u := ms.Unsatisfied([]string{"a", "c"}); len(u) != 1 || u[0] != "c needs b" {
		t.Errorf("unsatisfied: %v", u)
	}
	if _, err := ms.Closure([]string{"zzz"}); err == nil {
		t.Error("an unknown module must fail")
	}
	cyc := strings.Replace(catalogue, "requires: [cap]", "requires: [c]", 1)
	if _, err := Parse([]byte(cyc)); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Errorf("cycle: %v", err)
	}
	if _, err := Parse([]byte(strings.Replace(catalogue, "requires: [b]", "requires: [nothing]", 1))); err == nil || !strings.Contains(err.Error(), "neither a module") {
		t.Errorf("dangling requirement: %v", err)
	}
}

func TestSchemaRefusals(t *testing.T) {
	if _, err := Parse([]byte(strings.Replace(catalogue, "schema: 2", "schema: 3", 1))); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Errorf("schema 3: %v", err)
	}
	if _, err := Parse([]byte(strings.Replace(catalogue, "schema: 2", "schema: 1", 1))); err == nil || !strings.Contains(err.Error(), "schema 1") {
		t.Errorf("schema 1: %v", err)
	}
	if _, err := Parse([]byte(strings.Replace(catalogue, "memory_mib: 10, core", "memory_mib: 10, corre", 1))); err == nil {
		t.Error("an unknown module key must be refused")
	}
}

// The claim: a module is data. A fourth module appended to a catalogue, with its
// compose service, generates and is health-gated and cost-checked with no Go.
func TestNewModuleNeedsNoGo(t *testing.T) {
	repo := repoWith(t, edgeModes+`  extra:
    compose: x/compose.yml
    services: [extra]
    memory_mib: 16
    requires: [e]
    health: {http: [{path: /-/api/extra, contains: ok}]}
`, appCompose("      - x=y\n"))
	write := func(body string) {
		if err := os.MkdirAll(filepath.Join(repo, "x"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(repo, "x", "compose.yml"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	svc := func(mem string) string {
		return "services:\n  extra:\n    image: reg/extra:1@sha256:" + strings.Repeat("c", 64) + "\n    deploy: {resources: {limits: {memory: " + mem + "}}}\n"
	}
	write(svc("16m"))
	out, err := Generate(repo)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out[SourceDir+"/x/compose.yml.src"]; !ok {
		t.Error("the new module's compose is not in the embedded sources")
	}
	fsys := os.DirFS(repo)
	ms, _ := Load(fsys)
	set, err := GenSet(fsys, ms, "t", []string{"extra"})
	if err != nil || !strings.Contains(string(set.Compose), "BOTHY_IMAGE_EXTRA") {
		t.Fatalf("%v\n%s", err, set.Compose)
	}
	// the declared cost must be the limit
	write(svc("32m"))
	if _, err := Generate(repo); err == nil || !strings.Contains(err.Error(), "declares memory_mib 16") {
		t.Errorf("a wrong declared cost must fail: %v", err)
	}
	// and a module with no health contract is refused
	write(svc("16m"))
	bad := strings.Replace(edgeModes+`  extra:
    compose: x/compose.yml
    services: [extra]
    memory_mib: 16
`, "", "", 1)
	repo2 := repoWith(t, bad, appCompose("      - x=y\n"))
	_ = os.MkdirAll(filepath.Join(repo2, "x"), 0o755)
	_ = os.WriteFile(filepath.Join(repo2, "x", "compose.yml"), []byte(svc("16m")), 0o644)
	if _, err := Generate(repo2); err == nil || !strings.Contains(err.Error(), "no health contract") {
		t.Errorf("no health contract must fail: %v", err)
	}
}

// The pruned embedded copy must not go stale on a pin bump.
func TestBundleIgnoresImagePins(t *testing.T) {
	a, err := Generate(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	for p, b := range a {
		if strings.HasPrefix(p, SourceDir) && strings.HasSuffix(p, ".src") && strings.Contains(string(b), "@sha256:") {
			t.Errorf("%s carries an image digest, so a Dependabot bump would make it stale", p)
		}
	}
}
