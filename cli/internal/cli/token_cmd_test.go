//go:build !windows

package cli_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
	"github.com/YehudaBriskman/Bothy/cli/internal/tokens"
)

func TestTokenVerbsEndToEnd(t *testing.T) {
	isolate(t)
	state := filepath.Join(t.TempDir(), "tokens")
	env := map[string]string{"BOTHY_TOKEN_STATE": state}
	code, out, e := run(t, env, "token", "create", "--ops", "status,module.list", "--name", "laptop", "--ttl", "2h")
	if code != 0 {
		t.Fatalf("create: %d %s", code, e)
	}
	tok := strings.TrimSpace(out)
	if !tokens.TokenRE.MatchString(tok) || strings.Count(out, "\n") != 1 {
		t.Fatalf("stdout must be exactly the token: %q", out)
	}
	secret := tok[strings.IndexByte(tok, '.')+1:]
	if strings.Contains(e, secret) {
		t.Fatalf("the secret reached stderr: %s", e)
	}
	// list shows the id but never the secret or a digest
	code, out, e = run(t, env, "token", "list")
	id := tok[3:19]
	if code != 0 || !strings.Contains(out, id) || strings.Contains(out+e, secret) || strings.Contains(out, tokens.Digest(secret)) {
		t.Fatalf("list: %d %q %q", code, out, e)
	}
	code, out, _ = run(t, env, "--json", "token", "list")
	if code != 0 || strings.Contains(out, secret) || strings.Contains(out, "digest") {
		t.Fatalf("list --json: %d %q", code, out)
	}
	if code, _, e = run(t, env, "token", "revoke", id); code != 0 || !strings.Contains(e, "revoked") {
		t.Fatalf("revoke: %d %s", code, e)
	}
	if _, out, _ = run(t, env, "token", "list"); !strings.Contains(out, "revoked") {
		t.Fatalf("not revoked: %s", out)
	}
	// refusals: an unknown op, a bad ttl, a secret-looking flag value is never echoed
	for _, args := range [][]string{
		{"token", "create", "--ops", "nope", "--name", "x"},
		{"token", "create", "--ops", "status", "--name", "x", "--ttl", "9999d"},
		{"token", "create", "--ops", "status"},
		{"token", "create", "--ops", "status", "--name", "x", "--token", tok},
		{"token", "revoke", "../etc"},
		{"token", "frobnicate"},
	} {
		code, out, e := run(t, env, args...)
		if code == 0 || out != "" || strings.Contains(e, secret) {
			t.Errorf("%v: %d %q %q", args, code, out, e)
		}
	}
}

func TestTokenCreateOutFileIsPrivateAndPrintsNothing(t *testing.T) {
	isolate(t)
	dir := t.TempDir()
	env := map[string]string{"BOTHY_TOKEN_STATE": filepath.Join(dir, "tokens")}
	p := filepath.Join(dir, "tok")
	code, out, e := run(t, env, "token", "create", "--ops", "*", "--name", "ci", "--out", p)
	if code != 0 || out != "" {
		t.Fatalf("%d %q %s", code, out, e)
	}
	st, _ := os.Stat(p)
	b, _ := os.ReadFile(p)
	if st.Mode().Perm() != 0o600 || !tokens.TokenRE.MatchString(strings.TrimSpace(string(b))) {
		t.Fatalf("mode %04o content %q", st.Mode().Perm(), b)
	}
	// an existing --out is never overwritten, and no token is stranded by the refusal
	if code, _, _ := run(t, env, "token", "create", "--ops", "*", "--name", "ci2", "--out", p); code == 0 {
		t.Fatal("overwrote an existing file")
	}
	if _, out, _ := run(t, env, "token", "list"); strings.Count(out, "\n") != 1 {
		t.Fatalf("a refused create still minted: %s", out)
	}
	// and that file is what the CLI sends, as a bearer, to a fake box
	s := testkit.NewServer(t)
	cfg := filepath.Join(dir, "ctx")
	_ = cfg
	if code, _, e := run(t, nil, "context", "add", "b", s.URL, "--token-file", p, "--use"); code != 0 {
		t.Fatalf("%d %s", code, e)
	}
	if code, _, e := run(t, nil, "status"); code != 0 || s.Auth != "Bearer "+strings.TrimSpace(string(b)) {
		t.Fatalf("%d %s auth=%q", code, e, s.Auth)
	}
}

// The token verbs are not catalog operations: no HTTP route, no MCP tool, not in discover.
func TestTokenVerbsAreNotInTheCatalog(t *testing.T) {
	for _, op := range catalog.Ops {
		if strings.Contains(strings.ToLower(op.ID+op.Path+op.Tool+op.VerbString()), "token") {
			t.Errorf("catalog op %s mentions token", op.ID)
		}
	}
}

func TestRefusesAFlagTokenInArgv(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	tok := "bt_0123456789abcdef." + strings.Repeat("Z", 43)
	n := len(s.Requests)
	code, out, e := run(t, nil, "--url", s.URL, "--token", tok, "status")
	if code == 0 || strings.Contains(out+e, tok) || len(s.Requests) != n {
		t.Fatalf("a --token flag was honoured or echoed: %d %q %q", code, out, e)
	}
}
