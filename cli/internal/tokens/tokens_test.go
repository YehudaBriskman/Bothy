//go:build !windows

package tokens_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/tokens"
)

const t0 = 1_800_000_000

var known = func(id string) bool {
	switch id {
	case "status", "module.list", "update.status", "settings.get":
		return true
	}
	return false
}

// counterRand is a deterministic entropy stream, for the golden fixture ONLY.
type counterRand struct{ n uint64 }

func (c *counterRand) Read(p []byte) (int, error) {
	for i := range p {
		if i%32 == 0 {
			var b [8]byte
			binary.BigEndian.PutUint64(b[:], c.n)
			c.n++
			sum := sha256.Sum256(append([]byte("bothy-token-golden"), b[:]...))
			copy(p[i:], sum[:])
		}
	}
	return len(p), nil
}

var _ io.Reader = (*counterRand)(nil)

func stateDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "tokens")
}

func TestCreateWritesDigestOnlyAndPrivateModes(t *testing.T) {
	state := stateDir(t)
	tok, pub, err := tokens.Create(state, tokens.Spec{Kind: "cli", Role: "viewer", Name: "laptop", Ops: []string{"status"}, TTL: tokens.DefaultTTL},
		tokens.Env{KnownOp: known})
	if err != nil {
		t.Fatal(err)
	}
	if !tokens.TokenRE.MatchString(tok) || !strings.HasPrefix(tok, "bt_"+pub.ID+".") {
		t.Fatalf("token shape %q", tok)
	}
	secret := tok[strings.IndexByte(tok, '.')+1:]
	for _, name := range []string{tokens.FileName, tokens.AuditName, tokens.LockName} {
		b, err := os.ReadFile(filepath.Join(state, name))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(b, []byte(secret)) || bytes.Contains(b, []byte(tok)) {
			t.Fatalf("%s holds the secret", name)
		}
		st, _ := os.Stat(filepath.Join(state, name))
		if st.Mode().Perm() != 0o600 {
			t.Errorf("%s mode %04o", name, st.Mode().Perm())
		}
	}
	if st, _ := os.Stat(state); st.Mode().Perm() != 0o700 {
		t.Errorf("state dir mode %04o", st.Mode().Perm())
	}
	b, _ := os.ReadFile(filepath.Join(state, tokens.FileName))
	if !bytes.Contains(b, []byte(tokens.Digest(secret))) {
		t.Fatal("the digest is not on disk")
	}
	entries, _ := os.ReadDir(state)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tokens.json.") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	list, err := tokens.List(state, tokens.Env{})
	if err != nil || len(list) != 1 || list[0].Digest != "" || list[0].Status != "active" {
		t.Fatalf("list: %+v %v", list, err)
	}
}

func TestRefusals(t *testing.T) {
	env := tokens.Env{KnownOp: known}
	ok := tokens.Spec{Kind: "cli", Role: "viewer", Name: "x", Ops: []string{"status"}, TTL: time.Hour}
	for name, mod := range map[string]func(*tokens.Spec){
		"kind":       func(s *tokens.Spec) { s.Kind = "root" },
		"role":       func(s *tokens.Spec) { s.Role = "admin" },
		"name":       func(s *tokens.Spec) { s.Name = "bad\nname" },
		"empty ops":  func(s *tokens.Spec) { s.Ops = nil },
		"star+op":    func(s *tokens.Spec) { s.Ops = []string{"*", "status"} },
		"repeat":     func(s *tokens.Spec) { s.Ops = []string{"status", "status"} },
		"unknown op": func(s *tokens.Spec) { s.Ops = []string{"nope"} },
		"ttl low":    func(s *tokens.Spec) { s.TTL = time.Second },
		"ttl high":   func(s *tokens.Spec) { s.TTL = 366 * 24 * time.Hour },
	} {
		s := ok
		mod(&s)
		state := stateDir(t)
		if tok, _, err := tokens.Create(state, s, env); err == nil || tok != "" {
			t.Errorf("%s: accepted", name)
		}
		if _, err := os.Stat(filepath.Join(state, tokens.FileName)); err == nil {
			t.Errorf("%s: a refused request still wrote the store", name)
		}
	}
}

func TestLooseOrSymlinkedStoreIsRefused(t *testing.T) {
	env := tokens.Env{KnownOp: known}
	spec := tokens.Spec{Kind: "cli", Role: "viewer", Name: "x", Ops: []string{"*"}, TTL: time.Hour}
	state := stateDir(t)
	if _, _, err := tokens.Create(state, spec, env); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []os.FileMode{0o640, 0o604} {
		_ = os.Chmod(filepath.Join(state, tokens.FileName), mode)
		if _, err := tokens.List(state, env); err == nil || !strings.Contains(err.Error(), "0600") {
			t.Errorf("file mode %04o accepted: %v", mode, err)
		}
		if _, _, err := tokens.Create(state, spec, env); err == nil {
			t.Errorf("a loose file was written to anyway")
		}
	}
	_ = os.Chmod(filepath.Join(state, tokens.FileName), 0o600)
	_ = os.Chmod(state, 0o750)
	if _, err := tokens.List(state, env); err == nil || !strings.Contains(err.Error(), "0700") {
		t.Errorf("loose dir accepted: %v", err)
	}
	_ = os.Chmod(state, 0o700)
	// a symlinked token file
	real := filepath.Join(t.TempDir(), "elsewhere.json")
	_ = os.Rename(filepath.Join(state, tokens.FileName), real)
	if err := os.Symlink(real, filepath.Join(state, tokens.FileName)); err != nil {
		t.Fatal(err)
	}
	if _, err := tokens.List(state, env); err == nil {
		t.Error("a symlinked token file was followed")
	}
	// a symlinked state directory
	link := filepath.Join(t.TempDir(), "link")
	_ = os.Symlink(state, link)
	if _, err := tokens.List(link, env); err == nil {
		t.Error("a symlinked state directory was followed")
	}
	// damage
	state2 := stateDir(t)
	_ = os.MkdirAll(state2, 0o700)
	_ = os.WriteFile(filepath.Join(state2, tokens.FileName), []byte(`{"version":1,"tokens":[{"id":"zz"}]}`), 0o600)
	if _, err := tokens.List(state2, env); err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Errorf("damaged file: %v", err)
	}
}

func TestRevoke(t *testing.T) {
	state := stateDir(t)
	now := time.Unix(t0, 0)
	env := tokens.Env{KnownOp: known, Now: func() time.Time { return now }}
	_, pub, _ := tokens.Create(state, tokens.Spec{Kind: "cli", Role: "viewer", Name: "x", Ops: []string{"*"}, TTL: time.Hour}, env)
	if _, err := tokens.Revoke(state, "0000000000000000", env); err == nil {
		t.Error("revoking an unknown id succeeded")
	}
	if _, err := tokens.Revoke(state, "../x", env); err == nil {
		t.Error("revoking a malformed id succeeded")
	}
	if did, err := tokens.Revoke(state, pub.ID, env); !did || err != nil {
		t.Fatalf("first revoke: %v %v", did, err)
	}
	if did, err := tokens.Revoke(state, pub.ID, env); did || err != nil {
		t.Fatalf("second revoke: %v %v", did, err)
	}
	list, _ := tokens.List(state, env)
	if list[0].Status != "revoked" {
		t.Fatalf("status %s", list[0].Status)
	}
	later := tokens.Env{Now: func() time.Time { return now.Add(2 * time.Hour) }}
	list, _ = tokens.List(state, later)
	if list[0].Status != "revoked" { // revoked beats expired
		t.Fatalf("status %s", list[0].Status)
	}
}

// goldenCase is one presentation the Python store must judge the way Go says.
type goldenCase struct {
	Name   string   `json:"name"`
	Token  string   `json:"presented"`
	At     int64    `json:"at"`
	Expect string   `json:"expect"` // "ok" or "denied"
	Kind   string   `json:"kind,omitempty"`
	Role   string   `json:"role,omitempty"`
	Ops    []string `json:"ops,omitempty"`
}

// buildGolden mints with a fixed clock and a deterministic stream and returns the fixture: the store
// file Go wrote, and what Python must say about each token. TestGoldenIsCurrent holds the committed
// copy to this; apps/bothy-ops/checks/test_tokens.py replays it through tokenstore.py.
func buildGolden(t *testing.T) []byte {
	t.Helper()
	state := stateDir(t)
	now := time.Unix(t0, 0)
	env := tokens.Env{KnownOp: known, Now: func() time.Time { return now }, Rand: &counterRand{}}
	mint := func(kind, role, name string, ttl time.Duration, ops ...string) (string, tokens.Public) {
		tok, pub, err := tokens.Create(state, tokens.Spec{Kind: kind, Role: role, Name: name, Ops: ops, TTL: ttl}, env)
		if err != nil {
			t.Fatal(err)
		}
		return tok, pub
	}
	tokA, pubA := mint("cli", "viewer", "laptop", 24*time.Hour, "*")
	tokB, pubB := mint("mcp", "viewer", "agent one", 7*24*time.Hour, "status", "module.list")
	tokC, pubC := mint("cli", "operator", "to be revoked", 24*time.Hour, "*")
	tokD, pubD := mint("cli", "viewer", "short lived", time.Hour, "settings.get")
	now = now.Add(100 * time.Second)
	if _, err := tokens.Revoke(state, pubC.ID, env); err != nil {
		t.Fatal(err)
	}
	badSecret := tokA[:strings.IndexByte(tokA, '.')+1] + strings.Repeat("A", 43)
	cases := []goldenCase{
		{"cli viewer, all ops, in date", tokA, t0 + 60, "ok", "cli", "viewer", pubA.Ops},
		{"mcp viewer, two ops", tokB, t0 + 3600, "ok", "mcp", "viewer", pubB.Ops},
		{"short lived, in date", tokD, t0 + 60, "ok", "cli", "viewer", pubD.Ops},
		{"short lived, one second before expiry", tokD, t0 + 3599, "ok", "cli", "viewer", pubD.Ops},
		{"short lived, at its expiry", tokD, t0 + 3600, "denied", "", "", nil},
		{"short lived, long past", tokD, t0 + 7200, "denied", "", "", nil},
		{"revoked before use", tokC, t0 + 200, "denied", "", "", nil},
		{"right id, wrong secret", badSecret, t0 + 60, "denied", "", "", nil},
		{"all-ops token, past expiry", tokA, t0 + 2*86400, "denied", "", "", nil},
		{"mcp token, past expiry", tokB, t0 + 8*86400, "denied", "", "", nil},
	}
	raw, err := os.ReadFile(filepath.Join(state, tokens.FileName))
	if err != nil {
		t.Fatal(err)
	}
	var store any
	if err := json.Unmarshal(raw, &store); err != nil {
		t.Fatal(err)
	}
	out, err := json.MarshalIndent(map[string]any{
		"about": "TEST-ONLY tokens minted by cli/internal/tokens with a fixed clock and a deterministic stream; replayed by apps/bothy-ops/checks/test_tokens.py. Regenerate: UPDATE_GOLDEN=1 go test ./internal/tokens",
		"store": store, "cases": cases,
	}, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	return append(out, '\n')
}

const goldenPath = "../../../apps/bothy-ops/checks/golden/tokens/gotokens.json"

func TestGoldenIsCurrent(t *testing.T) {
	want := buildGolden(t)
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll(filepath.Dir(goldenPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenPath, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("the committed token golden is stale: run UPDATE_GOLDEN=1 go test ./internal/tokens, then python3 apps/bothy-ops/checks/test_tokens.py")
	}
}

// The other direction: a store the PYTHON tokenctl wrote must be read, listed and revoked by Go.
func TestReadsAStorePythonWrote(t *testing.T) {
	src, err := os.ReadFile("../../../apps/bothy-ops/checks/golden/tokens/pytokens.json")
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Store json.RawMessage `json:"store"`
		ID    string          `json:"id"`
	}
	if err := json.Unmarshal(src, &d); err != nil {
		t.Fatal(err)
	}
	state := stateDir(t)
	_ = os.MkdirAll(state, 0o700)
	_ = os.WriteFile(filepath.Join(state, tokens.FileName), append(d.Store, '\n'), 0o600)
	env := tokens.Env{Now: func() time.Time { return time.Unix(t0+60, 0) }}
	list, err := tokens.List(state, env)
	if err != nil || len(list) != 1 || list[0].ID != d.ID || list[0].Status != "active" {
		t.Fatalf("list: %+v %v", list, err)
	}
	if did, err := tokens.Revoke(state, d.ID, env); !did || err != nil {
		t.Fatalf("revoke: %v %v", did, err)
	}
}
