package install

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The release workflow WRITES release-manifest.json (scripts/gen-release-manifest.py)
// and this package READS it with a strict parser. v2026.11.1 shipped a manifest the
// binary refused ('unknown field "tag"') because nothing tied the two together.
// These tests are that tie: a drift in either side fails CI, not a real install.

func golden(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("testdata/release-manifest.v2026.11.1.json")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The real manifest of release v2026.11.1, exactly as published.
func TestParseManifestRealRelease(t *testing.T) {
	m, err := ParseManifest([]byte(golden(t)))
	if err != nil {
		t.Fatalf("the real v2026.11.1 manifest must parse: %v", err)
	}
	if m.Version != "2026.11.1" || len(m.Images) != 3 || len(m.ThirdParty) == 0 {
		t.Fatalf("unexpected content: %+v", m)
	}
	g := m.ThirdParty["grafana"]
	if g.Tag == nil || *g.Tag != "13.3.1" || len(g.PinnedIn) != 1 {
		t.Fatalf("informational third_party fields were dropped: %+v", g)
	}
}

// The generator's own output, run now against this checkout's compose files,
// must parse. Skipped only when python3 is absent.
func TestParseManifestFromGenerator(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not installed")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	gen := filepath.Join(root, "scripts", "gen-release-manifest.py")
	if _, err := os.Stat(gen); err != nil {
		t.Skip("not inside a full checkout: " + err.Error())
	}
	d64 := func(c string) string { return "sha256:" + strings.Repeat(c, 64) }
	out, err := exec.Command(py, "-I", gen, "--version", "2099.1.1", "--commit", strings.Repeat("a", 40), "--root", root,
		"--own", "bothy-web=ghcr.io/o/bothy-web@"+d64("1"),
		"--own", "bothy-files=ghcr.io/o/bothy-files@"+d64("2"),
		"--own", "bothy-ops=ghcr.io/o/bothy-ops@"+d64("3")).CombinedOutput()
	if err != nil {
		t.Fatalf("generator failed: %v\n%s", err, out)
	}
	m, err := ParseManifest(out)
	if err != nil {
		t.Fatalf("SCHEMA DRIFT: the generator's output is refused by ParseManifest: %v", err)
	}
	if len(m.ThirdParty) == 0 {
		t.Fatal("generator produced no third_party entries")
	}
}

func TestParseManifestStrictness(t *testing.T) {
	sub := func(old, new string) []byte {
		g := golden(t)
		if !strings.Contains(g, old) {
			t.Fatalf("golden no longer contains %q", old)
		}
		return []byte(strings.Replace(g, old, new, 1))
	}
	// A future top-level field: refused, named, and says the CLI is older.
	_, err := ParseManifest(sub(`"schema": 1,`, `"schema": 1, "signing": {"x": 1},`))
	if err == nil || !strings.Contains(err.Error(), `"signing"`) || !strings.Contains(err.Error(), "older than the release") || !strings.Contains(err.Error(), "top level") {
		t.Fatalf("unknown top-level field must be a clear error: %v", err)
	}
	// Own images stay strict.
	if _, err := ParseManifest(sub(`"platforms": [`, `"evil": true, "platforms": [`)); err == nil || !strings.Contains(err.Error(), `"evil"`) {
		t.Fatalf("an unknown field on an own image must be refused: %v", err)
	}
	// Third-party informational fields are typed.
	for _, bad := range []string{`"tag": 5,`, `"tag": ["a"],`} {
		if _, err := ParseManifest(sub(`"tag": "13.3.1",`, bad)); err == nil {
			t.Fatalf("third_party %s must be refused", bad)
		}
	}
	if _, err := ParseManifest(sub(`"tag": "13.3.1",`, `"tag": "13.3.1", "pinned_in": "x", "pinned_in2": 1,`)); err == nil {
		t.Fatal("bad third_party fields must be refused")
	}
	// An unknown third_party field is still refused.
	if _, err := ParseManifest(sub(`"tag": "13.3.1",`, `"tag": "13.3.1", "evil": 1,`)); err == nil {
		t.Fatal("unknown third_party field must be refused")
	}
	// A digest-less third-party ref is still refused.
	if _, err := ParseManifest(sub(`grafana/grafana@sha256:0615ec4fbd4072004b7d86b46ded63013a74b7d6eb1119273dd89e8fa25c13cf`, `grafana/grafana:13.3.1`)); err == nil || !strings.Contains(err.Error(), "digest reference") {
		t.Fatalf("a tag-only ref must be refused: %v", err)
	}
}
