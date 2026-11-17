package mcpserver

import (
	"bufio"
	"bytes"
	"encoding/json"
	"testing"
)

// guard's validator and the bounded line reader must never panic, and a frame
// the validator accepts must be JSON.
func FuzzFrameGuard(f *testing.F) {
	for _, s := range []string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, `[{"jsonrpc":"2.0","method":"x"}]`, `{`, `null`, `[]`, `123`,
		`{"jsonrpc":"2.0","id":{},"method":"x"}`, `{"jsonrpc":"2.0","id":1,"method":"x","params":"s"}`, "", "\n\n", "\x00",
	} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		if validFrame(b) && !json.Valid(bytes.TrimSpace(b)) {
			t.Fatalf("accepted a non-JSON frame: %q", b)
		}
		br := bufio.NewReaderSize(bytes.NewReader(b), 16)
		for i := 0; i < len(b)+2; i++ {
			line, tooBig, err := readFrame(br)
			if len(line) > maxFrame || (tooBig && line != nil) {
				t.Fatalf("readFrame broke its bound")
			}
			if err != nil {
				break
			}
		}
	})
}
