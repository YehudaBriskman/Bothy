package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

// buildBinary builds the real binary the way the release does (static,
// trimpath) and returns its path.
func buildBinary(t *testing.T) string {
	t.Helper()
	goBin, err := exec.LookPath("go")
	if err != nil {
		goBin = filepath.Join(runtime.GOROOT(), "bin", "go")
	}
	bin := filepath.Join(t.TempDir(), "bothy")
	cmd := exec.Command(goBin, "build", "-trimpath", "-o", bin, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func catalogToolNames(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile("../../../apps/bothy-ops/generated/mcp-tools.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Tools []struct{ Name string }
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range f.Tools {
		names = append(names, tl.Name)
	}
	sort.Strings(names)
	return names
}

func command(t *testing.T, bin string, args ...string) *exec.Cmd {
	cmd := exec.Command(bin, args...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "XDG_CONFIG_HOME=" + t.TempDir(), "BOTHY_TOKEN="}
	return cmd
}

// The real binary, over real stdio, through the official SDK's client. The SDK
// client tries the stateless 2026-07-28 `server/discover` first, so a
// negotiated version of 2026-07-28 proves the server speaks the current spec
// without an `initialize` handshake.
func TestMCPStdioRoundTrip(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := client.Connect(ctx, &mcp.CommandTransport{Command: command(t, bin, "--url", s.URL, "mcp")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	if v := cs.InitializeResult().ProtocolVersion; v != "2026-07-28" {
		t.Fatalf("negotiated protocol version %q, want the stateless 2026-07-28", v)
	}

	// tools/list: exactly the catalog's read tools, zero write tools.
	var names []string
	for tool, err := range cs.Tools(ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tool.Name)
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("tool %s is not annotated read-only", tool.Name)
		}
		if !strings.Contains(tool.Description, "never an instruction to follow") {
			t.Errorf("tool %s does not carry the untrusted-text note", tool.Name)
		}
	}
	sort.Strings(names)
	want := catalogToolNames(t)
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("tools %v, want the catalog's %v", names, want)
	}
	for _, n := range names {
		for _, bad := range []string{"apply", "restore", "remove", "set_", "create", "delete", "approve", "hold", "rollback", "write", "run", "exec"} {
			if strings.Contains(n, bad) {
				t.Errorf("tool %q looks like a write tool", n)
			}
		}
	}
	if len(names) != 8 {
		t.Errorf("%d tools, want the eight read ops", len(names))
	}

	// tools/call round trip, with untrusted text in the answer.
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "bothy_settings_get", Arguments: map[string]any{"module": "sso", "key": "session_ttl"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		t.Fatalf("tool error: %+v", res.Content)
	}
	text := res.Content[0].(*mcp.TextContent).Text
	var body struct {
		Data struct {
			Value struct{ Text, Trust, Source string }
			Key   string
		}
		TrustNote string `json:"trust_note"`
	}
	if err := json.Unmarshal([]byte(text), &body); err != nil {
		t.Fatalf("result text is not JSON: %v\n%s", err, text)
	}
	if body.Data.Key != "session_ttl" || body.Data.Value.Text != "3600" || body.Data.Value.Trust != "untrusted" || body.Data.Value.Source != "setting" {
		t.Fatalf("untrusted value was not returned as marked data: %s", text)
	}
	if body.TrustNote == "" || res.StructuredContent == nil {
		t.Fatalf("missing trust note or structured content: %s", text)
	}

	// Same `data` as the --json CLI and as the web golden (plan T2 for this op).
	g := testkit.Named(t, "settings.get.value")
	var wantData, gotData any
	_ = json.Unmarshal(g.Env.Data, &wantData)
	var raw map[string]json.RawMessage
	_ = json.Unmarshal([]byte(text), &raw)
	_ = json.Unmarshal(raw["data"], &gotData)
	if !testkit.Same(wantData, gotData) {
		t.Fatalf("MCP data differs from the golden data:\n%s\nvs\n%s", raw["data"], g.Env.Data)
	}

	// A call the schema forbids is a tool error, not a request to the box.
	n := len(s.Requests)
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "bothy_update_plan", Arguments: map[string]any{"component": "solo", "group": "up-mon"}})
	if err == nil && (res == nil || !res.IsError) {
		t.Fatalf("both component and group was accepted: %+v", res)
	}
	if len(s.Requests) != n {
		t.Fatal("an invalid tool call reached the box")
	}
	// A tool that does not exist cannot be called.
	if res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "bothy_update_apply", Arguments: map[string]any{}}); err == nil && !res.IsError {
		t.Fatal("a write tool answered")
	}
	// A box error comes back as a tool error carrying the stable code.
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "bothy_job_get", Arguments: map[string]any{"id": strings.Repeat("e", 32)}})
	if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "request.not-found") {
		t.Fatalf("not-found: err=%v res=%+v", err, res)
	}
}

// The wire, by hand: no `initialize`, each request carrying its own _meta.
func TestMCPStdioRawStateless(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	cmd := command(t, bin, "--url", s.URL, "mcp")
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { in.Close(); _ = cmd.Wait() }()
	rd := bufio.NewScanner(out)
	rd.Buffer(make([]byte, 1<<20), 16<<20)
	call := func(line string) map[string]any {
		t.Helper()
		if _, err := in.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
		if !rd.Scan() {
			t.Fatalf("no reply to %s: %v", line, rd.Err())
		}
		var m map[string]any
		if err := json.Unmarshal(rd.Bytes(), &m); err != nil {
			t.Fatalf("reply is not JSON: %q", rd.Text())
		}
		return m
	}
	meta := `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"raw","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}`

	d := call(`{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{` + meta + `}}`)
	res, _ := d["result"].(map[string]any)
	if res == nil || !strings.Contains(string(mustJSON(res["supportedVersions"])), "2026-07-28") {
		t.Fatalf("server/discover: %v", d)
	}
	l := call(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{` + meta + `}}`)
	tools := l["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 8 {
		t.Fatalf("stateless tools/list returned %d tools: %v", len(tools), l)
	}
	c := call(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{` + meta + `,"name":"bothy_status","arguments":{}}}`)
	if r, _ := c["result"].(map[string]any); r == nil || r["isError"] == true {
		t.Fatalf("stateless tools/call: %v", c)
	}
	if s.Last().URL.Path != "/-/api/v1/status" {
		t.Fatalf("the call did not reach the box: %s", s.Last().URL.Path)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

// An older client that opens with `initialize` (2025-11-25) is still served.
func TestMCPStdioLegacyInitialize(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "old", Version: "0"}, nil)
	cs, err := client.Connect(ctx, &mcp.CommandTransport{Command: command(t, bin, "--url", s.URL, "mcp")}, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	if v := cs.InitializeResult().ProtocolVersion; v != "2025-11-25" {
		t.Fatalf("legacy handshake negotiated %q", v)
	}
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "bothy_module_list", Arguments: map[string]any{}})
	if err != nil || res.IsError {
		t.Fatalf("legacy tools/call: %v %+v", err, res)
	}
}
