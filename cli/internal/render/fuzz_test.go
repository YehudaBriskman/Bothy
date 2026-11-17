package render_test

import (
	"bytes"
	"testing"
	"unicode/utf8"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
	"github.com/YehudaBriskman/Bothy/cli/internal/render"
	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

func dangerous(r rune) bool {
	switch {
	case r == '\n' || r == '\t':
		return false
	case r < 0x20, r == 0x7f, r >= 0x80 && r <= 0x9f:
		return true
	case r >= 0x200b && r <= 0x200f, r >= 0x2028 && r <= 0x202e, r == 0x2060, r >= 0x2066 && r <= 0x2069, r == 0xfeff:
		return true
	}
	return false
}

// Human and JSON rendering of arbitrary `data` for every op: never a panic,
// and nothing dangerous in what would be printed. Seeds are the goldens' data.
func FuzzRender(f *testing.F) {
	for _, g := range testkit.Goldens(f) {
		if g.Env.OK {
			f.Add(opFor(g.Path), []byte(g.Env.Data))
		}
	}
	f.Add("status", []byte(`{"server":{"version":"\u001b[2J","apiVersion":1},"updates":{}}`))
	f.Add("job.get", []byte(`{"job":{"id":"x","error":{"text":"\u001b]0;t\u0007","trust":"untrusted","source":"s"}}}`))
	f.Add("update.status", []byte(`{"components":[null,1,"x",[],{}]}`))
	f.Fuzz(func(t *testing.T, op string, data []byte) {
		known := false
		for _, o := range catalog.Ops {
			known = known || o.ID == op
		}
		if !known {
			return
		}
		var hb, jb bytes.Buffer
		_ = render.Human(&hb, op, data)
		_ = render.JSON(&jb, data)
		for _, b := range [][]byte{hb.Bytes(), jb.Bytes()} {
			if !utf8.Valid(b) {
				t.Fatalf("invalid UTF-8 printed for %s: %q", op, b)
			}
			for _, r := range string(b) {
				if dangerous(r) {
					t.Fatalf("%U printed for %s from %q: %q", r, op, data, b)
				}
			}
		}
	})
}
