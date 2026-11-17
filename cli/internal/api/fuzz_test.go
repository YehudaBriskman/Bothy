package api

import (
	"net/http"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

func badRune(r rune) bool {
	switch {
	case r == '\n' || r == '\t':
		return false
	case r < 0x20, r == 0x7f, r >= 0x80 && r <= 0x9f:
		return true
	case r >= 0x200b && r <= 0x200f, r >= 0x2028 && r <= 0x202e, r == 0x2060, r >= 0x2066 && r <= 0x2069, r == 0xfeff, r == 0x061c:
		return true
	}
	return false
}

var sanitizeSeeds = []string{
	"plain", "", "\x1b[31mred\x1b[0m", "\x1b]0;title\x07x", "\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\",
	"\x1bP1$r\x1b\\y", "\u009b31mx", "\u009d0;t\u009cx", "a‮b⁦c⁩", "nul\x00byte", "\x1b", "\x1b[", "\x1b]",
	"\x1b[\x1b[\x1b[", "\xff\xfe invalid utf8", "a\u2028b\u2029c", "\ufeffbom", "\x1b\n", "\x1b(B", "\x1b#8", "​‌‍",
	"tab\tnl\n", "\x1b]0;" + strings.Repeat("a", 10000),
}

// Sanitize must never panic, never emit a dangerous rune or invalid UTF-8,
// and must be idempotent (what it prints is what it would print again).
func FuzzSanitize(f *testing.F) {
	for _, s := range sanitizeSeeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		out := Sanitize(s)
		if !utf8.ValidString(out) {
			t.Fatalf("invalid UTF-8 out of %q: %q", s, out)
		}
		for _, r := range out {
			if badRune(r) {
				t.Fatalf("%U survived in %q (from %q)", r, out, s)
			}
		}
		if again := Sanitize(out); again != out {
			t.Fatalf("not idempotent: %q -> %q -> %q", s, out, again)
		}
		if ol := OneLine(s); strings.ContainsAny(ol, "\n\t") || ol != strings.TrimSpace(ol) {
			t.Fatalf("OneLine left whitespace structure: %q", ol)
		}
		if len(out) > len(s)+3*utf8.RuneCountInString(s) { // U+FFFD expansion is the only growth
			t.Fatalf("output grew: %d -> %d", len(s), len(out))
		}
		_ = unicode.IsPrint
	})
}

var envSeeds = []string{
	`{"ok":true,"request_id":"r_0","data":{"a":1},"warnings":[]}`,
	`{"ok":false,"request_id":"r_0","error":{"code":"request.invalid","message":"m","details":{},"hint":null}}`,
	`{"ok":true}`, `{"ok":false}`, `null`, `[]`, `{}`, `{"ok":true,"ok":false}`, `{"ok":"yes"}`,
	`{"ok":true,"data":null}`, `{"ok":false,"error":{"code":5}}`, `{"ok":false,"error":{"code":"x","hint":7}}`,
	`{"ok":true,"data":` + strings.Repeat("[", 100) + strings.Repeat("]", 100) + `}`, `{"ok":true,"data":"\u001b[2J"}`,
	"", "{", `{"ok":true,"warnings":{}}`, `{"ok":true,"data":{},"request_id":{}}`,
}

// The envelope decoder, and the error path built from it, must never panic on
// any body, and an error it builds must print without control characters.
func FuzzDecodeEnvelope(f *testing.F) {
	for _, s := range envSeeds {
		f.Add(s, 200)
		f.Add(s, 500)
	}
	f.Fuzz(func(t *testing.T, body string, status int) {
		resp := &http.Response{StatusCode: status, Header: http.Header{}}
		env, err := decode(resp, []byte(body))
		if err != nil {
			if _, ok := err.(*ProtocolError); !ok {
				t.Fatalf("decode returned %T", err)
			}
			for _, r := range err.Error() {
				if badRune(r) {
					t.Fatalf("control rune in a protocol error: %q", err.Error())
				}
			}
			return
		}
		if env == nil || env.OK == nil {
			t.Fatalf("decode returned an envelope without ok: %+v", env)
		}
		if !*env.OK && env.Err != nil {
			e := &Error{Code: env.Err.Code, Message: env.Err.Message, HTTP: status, RequestID: env.RequestID}
			if env.Err.Hint != nil {
				e.Hint = *env.Err.Hint
			}
			for _, r := range e.Error() {
				if badRune(r) {
					t.Fatalf("control rune in %q", e.Error())
				}
			}
			_ = e.ExitCode()
		}
	})
}

// The Bothy-Server header parser and the version compare take server text.
func FuzzServerHeaderAndVersions(f *testing.F) {
	f.Add("2026.11.0 api=1 min-client=0.0.0", "2026.11.0")
	f.Add("", "")
	f.Add("x api=99999999999999999999 min-client=a.b.c", "v1.2.3-rc1+x")
	f.Fuzz(func(t *testing.T, h, v string) {
		if s, ok := ParseServerHeader(h); ok {
			_ = versionLess(v, s.MinClient)
		}
		_ = versionLess(v, h)
		_, _ = parseVer(v)
	})
}
