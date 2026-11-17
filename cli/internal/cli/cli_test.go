package cli_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
	"github.com/YehudaBriskman/Bothy/cli/internal/cli"
	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

func run(t *testing.T, env map[string]string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	code = cli.Run(args, cli.IO{
		In: strings.NewReader(""), Out: &out, Err: &errb, Version: "2026.11.0",
		Getenv: func(k string) string { return env[k] },
	})
	return code, out.String(), errb.String()
}

func isolate(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("BOTHY_TOKEN", "")
}

// One fake-server test per read op: the argument vector, what the box must
// receive (path and exactly these query parameters), and a line of the output.
func TestEachReadOpAgainstFakeServer(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	id32 := strings.Repeat("c", 32)
	for _, tc := range []struct {
		name  string
		args  []string
		path  string
		query map[string]string
		want  string
	}{
		{"status", []string{"status"}, "/-/api/v1/status", nil, "Bothy 2026.11.0"},
		{"module.list", []string{"module", "list"}, "/-/api/v1/modules", nil, "just up-mon"},
		{"modules alias", []string{"modules"}, "/-/api/v1/modules", nil, "just up-mon"},
		{"update.status", []string{"update", "status"}, "/-/api/v1/updates/status", nil, "COMPONENT"},
		{"update.plan component", []string{"update", "plan", "--component", "grafana"}, "/-/api/v1/updates/plan", map[string]string{"component": "grafana"}, "56f6f9d79eb4c3bf5ef9fb59"},
		{"update.plan group", []string{"update", "plan", "--group=up-mon"}, "/-/api/v1/updates/plan", map[string]string{"group": "up-mon"}, "MEMBER"},
		{"update.history", []string{"update", "history"}, "/-/api/v1/updates/history", nil, "rolled_back"},
		{"job.get positional", []string{"job", "show", id32}, "/-/api/v1/job", map[string]string{"id": id32}, "rolled_back"},
		{"events", []string{"events", "--limit", "2"}, "/-/api/v1/events", map[string]string{"limit": "2"}, "more: yes"},
		{"settings.get", []string{"settings", "get", "sso", "session_ttl"}, "/-/api/v1/settings", map[string]string{"module": "sso", "key": "session_ttl"}, `[untrusted setting: "3600"]`},
		{"discover", []string{"discover"}, "/-/api/v1/discover", nil, "update.plan"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, out, errs := run(t, nil, append([]string{"--url", s.URL}, tc.args...)...)
			if code != 0 {
				t.Fatalf("exit %d, stderr: %s", code, errs)
			}
			if !strings.Contains(out, tc.want) {
				t.Fatalf("stdout lacks %q:\n%s", tc.want, out)
			}
			r := s.Last()
			if r.URL.Path != tc.path {
				t.Fatalf("path %s, want %s", r.URL.Path, tc.path)
			}
			q := r.URL.Query()
			if len(q) != len(tc.query) {
				t.Fatalf("query %v, want exactly %v", q, tc.query)
			}
			for k, v := range tc.query {
				if q.Get(k) != v {
					t.Fatalf("query %v, want %v", q, tc.query)
				}
			}
			// --json prints valid JSON of the same data
			code, out, errs = run(t, nil, append([]string{"--json", "--url", s.URL}, tc.args...)...)
			if code != 0 {
				t.Fatalf("--json exit %d: %s", code, errs)
			}
			var v map[string]any
			if err := json.Unmarshal([]byte(out), &v); err != nil {
				t.Fatalf("--json output is not a JSON object: %v\n%s", err, out)
			}
		})
	}
}

// Every op in the catalog that is a GET and has a verb is reachable from the
// command line: adding one to the catalog adds the command with no Go edit.
func TestEveryCatalogVerbIsACommand(t *testing.T) {
	isolate(t)
	_, help, _ := run(t, nil, "help")
	for _, op := range catalog.Ops {
		if !strings.Contains(help, op.VerbString()) {
			t.Errorf("help does not list %q", op.VerbString())
		}
	}
}

func TestExitCodes(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	for _, tc := range []struct {
		name string
		args []string
		want int
		in   string // stderr substring
	}{
		{"unknown job -> not found", []string{"job", "show", strings.Repeat("e", 32)}, 66, "request.not-found"},
		{"unregistered setting -> not found", []string{"settings", "get", "sso", "nope"}, 66, "not a registered setting"},
		{"bad id -> usage, never sent", []string{"job", "show", "XYZ"}, 64, "does not match"},
		{"both targets -> usage", []string{"update", "plan", "--component", "solo", "--group", "up-mon"}, 64, "exactly one"},
		{"unknown flag", []string{"status", "--frobnicate", "1"}, 64, "unknown flag"},
		{"unknown word is refused by name", []string{"frobnicate"}, 64, `unknown command "frobnicate"`},
		{"half a noun", []string{"settings"}, 64, "settings get"},
		{"missing positional", []string{"settings", "get", "sso"}, 64, "missing required parameter"},
		{"limit out of range", []string{"update", "history", "--limit", "500"}, 64, "1..100"},
		{"write flag on mcp", []string{"mcp", "--write"}, 64, "read tools only"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := len(s.Requests)
			code, _, errs := run(t, nil, append([]string{"--url", s.URL}, tc.args...)...)
			if code != tc.want || !strings.Contains(errs, tc.in) {
				t.Fatalf("exit %d (want %d), stderr: %s", code, tc.want, errs)
			}
			if tc.want == 64 && strings.Contains(tc.name, "never sent") && len(s.Requests) != before {
				t.Fatal("an invalid request reached the box")
			}
		})
	}
}

func TestUnreachableExit10(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	url := s.URL
	s.Close()
	code, _, errs := run(t, nil, "--url", url, "--timeout", "1s", "status")
	if code != 10 || !strings.Contains(errs, "cannot reach") {
		t.Fatalf("exit %d: %s", code, errs)
	}
}

func TestNoContextIsAUsageError(t *testing.T) {
	isolate(t)
	code, _, errs := run(t, nil, "status")
	if code != 64 || !strings.Contains(errs, "context add") {
		t.Fatalf("exit %d: %s", code, errs)
	}
}

func TestSkewThroughTheCLI(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	s.Header = "9999.1.0 api=1 min-client=2099.1.0"
	s.Mutate = func(p string, b []byte) []byte {
		if p == "/-/api/v1/discover" {
			return []byte(strings.Replace(string(b), `"minClient": "0.0.0"`, `"minClient": "2099.1.0"`, 1))
		}
		return b
	}
	code, out, errs := run(t, nil, "--url", s.URL, "status")
	if code != 0 || !strings.Contains(errs, "update the CLI") || !strings.Contains(out, "Bothy") {
		t.Fatalf("reads must continue with a note: exit %d\n%s\n%s", code, out, errs)
	}
	s2 := testkit.NewServer(t)
	s2.Header = "9999.1.0 api=2 min-client=0.0.0"
	code, _, errs = run(t, nil, "--url", s2.URL, "status")
	if code != 78 || !strings.Contains(errs, "update the CLI") {
		t.Fatalf("exit %d: %s", code, errs)
	}
}

func TestVersionShowsBuildCommit(t *testing.T) {
	isolate(t)
	var out, errb bytes.Buffer
	sha := "0123456789abcdef0123456789abcdef01234567"
	code := cli.Run([]string{"version"}, cli.IO{
		In: strings.NewReader(""), Out: &out, Err: &errb, Version: "2026.11.0", Commit: sha,
		Getenv: func(string) string { return "" },
	})
	if code != 0 || !strings.Contains(out.String(), "bothy 2026.11.0 (commit 0123456789ab, speaks api 1)") {
		t.Fatalf("exit %d\n%s", code, out.String())
	}
	out.Reset()
	code = cli.Run([]string{"--json", "version"}, cli.IO{
		In: strings.NewReader(""), Out: &out, Err: &errb, Version: "2026.11.0", Commit: sha,
		Getenv: func(string) string { return "" },
	})
	if code != 0 || !strings.Contains(out.String(), `"commit": "`+sha+`"`) {
		t.Fatalf("exit %d\n%s", code, out.String())
	}
}

func TestVersion(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	code, out, _ := run(t, nil, "--url", s.URL, "version")
	if code != 0 || !strings.Contains(out, "bothy 2026.11.0 (speaks api 1)") || !strings.Contains(out, "box    2026.11.0 api=1") {
		t.Fatalf("exit %d\n%s", code, out)
	}
	// offline: still prints the client version, exit 0
	code, out, _ = run(t, nil, "version")
	if code != 0 || !strings.Contains(out, "bothy 2026.11.0") || !strings.Contains(out, "not configured") {
		t.Fatalf("exit %d\n%s", code, out)
	}
	code, out, _ = run(t, nil, "--json", "--url", s.URL, "version")
	var v struct {
		Client struct{ Version string }
		Server struct{ ApiVersion int }
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil || code != 0 || v.Client.Version != "2026.11.0" || v.Server.ApiVersion != 1 {
		t.Fatalf("exit %d %v\n%s", code, err, out)
	}
}

func TestContextAddListUse(t *testing.T) {
	isolate(t)
	if code, _, e := run(t, nil, "context", "add", "lab", "http://127.0.0.1:9999"); code != 0 {
		t.Fatalf("add: %d %s", code, e)
	}
	if code, _, e := run(t, nil, "context", "add", "box", "https://box.example"); code != 0 {
		t.Fatalf("add: %d %s", code, e)
	}
	_, out, _ := run(t, nil, "context", "list")
	if !strings.Contains(out, "* lab") || !strings.Contains(out, "  box") {
		t.Fatalf("list:\n%s", out)
	}
	if code, _, e := run(t, nil, "context", "use", "box"); code != 0 {
		t.Fatalf("use: %d %s", code, e)
	}
	_, out, _ = run(t, nil, "context", "list")
	if !strings.Contains(out, "* box") {
		t.Fatalf("list after use:\n%s", out)
	}
	if code, _, _ := run(t, nil, "context", "use", "nope"); code != 64 {
		t.Fatalf("use unknown: %d", code)
	}
	// file mode
	p := filepath.Join(os.Getenv("XDG_CONFIG_HOME"), "bothy", "config.json")
	st, err := os.Stat(p)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("config %v mode %v", err, st)
	}
	if st, _ := os.Stat(filepath.Dir(p)); st.Mode().Perm() != 0o700 {
		t.Fatalf("config dir mode %v", st.Mode().Perm())
	}
	// a loose file is refused
	if err := os.Chmod(p, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, e := run(t, nil, "context", "list"); code == 0 || !strings.Contains(e, "0600") {
		t.Fatalf("loose config accepted: %d %s", code, e)
	}
	_ = os.Chmod(p, 0o600)
	// bad names and URLs
	if code, _, _ := run(t, nil, "context", "add", "Bad Name", "http://127.0.0.1"); code != 64 {
		t.Fatalf("bad name: %d", code)
	}
	if code, _, _ := run(t, nil, "context", "add", "x", "ftp://host"); code != 64 {
		t.Fatalf("bad url: %d", code)
	}
}

const (
	fileTok = "bt_0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	envTok  = "bt_fedcba9876543210.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
)

func TestContextSelectionAndTokenGuardThroughTheCLI(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	tok := filepath.Join(t.TempDir(), "tok")
	if err := os.WriteFile(tok, []byte(fileTok+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A token context over cleartext http to a LAN address is refused at `add`.
	if code, _, e := run(t, nil, "context", "add", "lan", "http://192.168.1.5:8080", "--token-file", tok); code != 64 || !strings.Contains(e, "cleartext") {
		t.Fatalf("add lan+token: %d %s", code, e)
	}
	if code, _, e := run(t, nil, "context", "add", "local", s.URL, "--token-file", tok, "--use"); code != 0 {
		t.Fatalf("add local+token: %d %s", code, e)
	}
	if code, _, e := run(t, nil, "status"); code != 0 {
		t.Fatalf("status via context: %d %s", code, e)
	}
	if s.Auth != "Bearer "+fileTok {
		t.Fatalf("token not sent from file: %q", s.Auth)
	}
	// BOTHY_TOKEN wins over the file; BOTHY_URL to a LAN address with it is refused, nothing sent.
	n := len(s.Requests)
	code, _, e := run(t, map[string]string{"BOTHY_URL": "http://192.168.1.5:8080", "BOTHY_TOKEN": envTok}, "status")
	if code != 64 && code != 1 || !strings.Contains(e, "cleartext") || len(s.Requests) != n {
		t.Fatalf("token over cleartext LAN http was not refused: %d %s", code, e)
	}
	code, _, e = run(t, map[string]string{"BOTHY_TOKEN": envTok}, "status")
	if code != 0 || s.Auth != "Bearer "+envTok {
		t.Fatalf("BOTHY_TOKEN must win over the file: %d %s auth=%q", code, e, s.Auth)
	}
	// a world-readable token file is refused
	if err := os.Chmod(tok, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, _, e := run(t, nil, "status"); code == 0 || !strings.Contains(e, "token file") {
		t.Fatalf("loose token file accepted: %d %s", code, e)
	}
}
