//go:build !windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

const rawMeta = `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"raw","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}`

type mcpProc struct {
	t    *testing.T
	cmd  *exec.Cmd
	in   interface{ Write([]byte) (int, error) }
	cls  func() error
	rd   *bufio.Scanner
	done chan struct{}
}

func startMCP(t *testing.T, bin string, args ...string) *mcpProc {
	t.Helper()
	cmd := command(t, bin, args...)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &mcpProc{t: t, cmd: cmd, in: in, cls: in.Close, rd: bufio.NewScanner(out), done: make(chan struct{})}
	p.rd.Buffer(make([]byte, 1<<20), 16<<20)
	go func() { _ = cmd.Wait(); close(p.done) }()
	t.Cleanup(func() { _ = cmd.Process.Kill() })
	return p
}

func (p *mcpProc) send(s string) {
	p.t.Helper()
	if _, err := p.in.Write([]byte(s + "\n")); err != nil {
		p.t.Fatalf("server gone: %v", err)
	}
}

// next reads one reply line within d.
func (p *mcpProc) next(d time.Duration) (map[string]any, bool) {
	p.t.Helper()
	ch := make(chan bool, 1)
	go func() { ch <- p.rd.Scan() }()
	select {
	case ok := <-ch:
		if !ok {
			return nil, false
		}
		var m map[string]any
		if err := json.Unmarshal(p.rd.Bytes(), &m); err != nil {
			p.t.Fatalf("reply is not JSON: %q", p.rd.Text())
		}
		return m, true
	case <-time.After(d):
		p.t.Fatalf("no reply within %v", d)
	}
	return nil, false
}

func TestMCPSurvivesHostileFrames(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	p := startMCP(t, bin, "--url", s.URL, "mcp")
	list := `{"jsonrpc":"2.0","id":%d,"method":"tools/list","params":{` + rawMeta + `}}`
	id := 0
	alive := func(what string) {
		t.Helper()
		id++
		p.send(fmt.Sprintf(list, id))
		for {
			m, ok := p.next(10 * time.Second)
			if !ok {
				t.Fatalf("the server died after: %s", what)
			}
			if v, _ := m["id"].(float64); int(v) == id {
				if tl, _ := m["result"].(map[string]any); tl == nil || len(tl["tools"].([]any)) != 8 {
					t.Fatalf("after %s, tools/list: %v", what, m)
				}
				return
			}
		}
	}
	alive("start")
	frames := map[string]string{
		"not json":                 `{this is not json`,
		"bare number":              `123`,
		"bare string":              `"x"`,
		"null":                     `null`,
		"empty array":              `[]`,
		"array of numbers":         `[1,2]`,
		"unterminated":             `{"jsonrpc":"2.0","id":1,"method":"tools/list"`,
		"truncated utf8":           "{\"a\":\"\xff\xfe\"}",
		"NUL bytes":                "\x00\x00\x00",
		"no method":                `{"jsonrpc":"2.0","id":5}`,
		"method is a number":       `{"jsonrpc":"2.0","id":6,"method":5}`,
		"wrong version":            `{"jsonrpc":"1.0","id":7,"method":"tools/list"}`,
		"params is a string":       `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":"nope"}`,
		"params is an array":       `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":[1]}`,
		"call with no name":        `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{` + rawMeta + `}}`,
		"arguments is an array":    `{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{` + rawMeta + `,"name":"bothy_status","arguments":[1]}}`,
		"arguments hostile types":  `{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{` + rawMeta + `,"name":"bothy_job_get","arguments":{"id":{"a":[1,2]}}}}`,
		"huge integer argument":    `{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{` + rawMeta + `,"name":"bothy_update_history","arguments":{"limit":1e999}}}`,
		"unknown method":           `{"jsonrpc":"2.0","id":14,"method":"tools/destroy","params":{` + rawMeta + `}}`,
		"write-looking tool":       `{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{` + rawMeta + `,"name":"bothy_update_apply","arguments":{"component":"solo"}}}`,
		"deep nesting in params":   `{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{` + rawMeta + `,"name":"bothy_status","arguments":` + strings.Repeat("[", 20000) + strings.Repeat("]", 20000) + `}}`,
		"notification with a body": `{"jsonrpc":"2.0","method":"notifications/whatever","params":{"x":1}}`,
		"oversized frame (3 MiB)":  `{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"` + strings.Repeat("a", 3<<20) + `"}}`,
		"batch of junk":            `[{"jsonrpc":"2.0"},{"x":1}]`,
	}
	for name, f := range frames {
		p.send(f)
		alive(name)
	}
	// The write-looking tool really is refused, not merely survived.
	p.send(`{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{` + rawMeta + `,"name":"bothy_update_apply","arguments":{}}}`)
	for {
		m, ok := p.next(10 * time.Second)
		if !ok {
			t.Fatal("died")
		}
		if v, _ := m["id"].(float64); v == 100 {
			if m["error"] == nil {
				if r, _ := m["result"].(map[string]any); r == nil || r["isError"] != true {
					t.Fatalf("a write tool was served: %v", m)
				}
			}
			break
		}
	}
	for _, r := range s.Requests {
		if r.Method != http.MethodGet {
			t.Fatalf("the MCP server sent a %s to the box", r.Method)
		}
	}
	_ = p.cls()
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
		t.Fatal("did not exit on stdin EOF")
	}
}

func TestMCPAnswersAParseErrorAndAFrameTooLarge(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	p := startMCP(t, bin, "--url", s.URL, "mcp")
	p.send(`{nope`)
	m, ok := p.next(10 * time.Second)
	e, _ := m["error"].(map[string]any)
	if !ok || e == nil || e["code"].(float64) != -32700 {
		t.Fatalf("a malformed frame must be answered -32700, got %v", m)
	}
	p.send(`{"jsonrpc":"2.0","id":1,"method":"x","params":{"p":"` + strings.Repeat("a", 2<<20) + `"}}`)
	m, ok = p.next(10 * time.Second)
	e, _ = m["error"].(map[string]any)
	if !ok || e == nil || e["code"].(float64) != -32600 {
		t.Fatalf("an oversized frame must be answered -32600, got %v", m)
	}
}

func TestMCPConcurrentCalls(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	p := startMCP(t, bin, "--url", s.URL, "mcp")
	const n = 60
	var wg sync.WaitGroup
	for i := 1; i <= n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tool := []string{"bothy_status", "bothy_module_list", "bothy_update_status"}[i%3]
			p.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{%s,"name":%q,"arguments":{}}}`, i, rawMeta, tool))
		}(i)
	}
	wg.Wait()
	seen := map[int]bool{}
	for len(seen) < n {
		m, ok := p.next(20 * time.Second)
		if !ok {
			t.Fatalf("server gone after %d replies", len(seen))
		}
		if r, _ := m["result"].(map[string]any); r == nil || r["isError"] == true {
			t.Fatalf("call failed: %v", m)
		}
		seen[int(m["id"].(float64))] = true
	}
}

func TestMCPStdinClosedMidCall(t *testing.T) {
	bin := buildBinary(t)
	disc := testkit.Named(t, "discover").Body
	block := make(chan struct{})
	srv := newBlockingServer(disc, block)
	defer srv.Close()
	defer close(block)
	p := startMCP(t, bin, "--url", srv.URL, "--timeout", "30s", "mcp")
	p.send(fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{%s,"name":"bothy_status","arguments":{}}}`, rawMeta))
	time.Sleep(500 * time.Millisecond) // the call is now parked on the box
	start := time.Now()
	_ = p.cls()
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
		t.Fatal("still running 10 s after stdin closed with a call in flight")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("took %v to exit", d)
	}
}
