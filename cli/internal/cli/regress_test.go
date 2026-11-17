package cli_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

// Found by driving the binary at the real server: a trailing unknown flag said
// "needs a value" instead of "unknown flag".
func TestTrailingUnknownFlagIsUnknownNotMissingValue(t *testing.T) {
	isolate(t)
	s := testkit.NewServer(t)
	code, _, errs := run(t, nil, "--url", s.URL, "status", "--bogus")
	if code != 64 || !strings.Contains(errs, "unknown flag --bogus") {
		t.Fatalf("code %d, stderr %q", code, errs)
	}
	code, _, errs = run(t, nil, "--url", s.URL, "update", "history", "--limit")
	if code != 64 || !strings.Contains(errs, "needs a value") {
		t.Fatalf("a known flag with no value: code %d, stderr %q", code, errs)
	}
	code, _, errs = run(t, nil, "status", "--url")
	if code != 64 || !strings.Contains(errs, "--url needs a value") {
		t.Fatalf("global flag with no value: code %d, stderr %q", code, errs)
	}
	if n := len(s.Requests); n != 0 {
		t.Fatalf("a usage error sent %d requests", n)
	}
}

func hostileBox(t *testing.T, body string, status int) string {
	t.Helper()
	disc := testkit.Named(t, "discover").Body
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Bothy-Server", "2026.11.0 api=1 min-client=0.0.0")
		if strings.HasSuffix(r.URL.Path, "/discover") {
			_, _ = w.Write(disc)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.Close)
	return s.URL
}

// An error code from the box is printed: it must be sanitised like the message.
func TestErrorCodeIsSanitised(t *testing.T) {
	isolate(t)
	u := hostileBox(t, `{"ok":false,"request_id":"r","error":{"code":"made.up\u001b[2J‮","message":"m"}}`, 418)
	_, _, errs := run(t, nil, "--url", u, "status")
	if strings.ContainsAny(errs, "\x1b‮") {
		t.Fatalf("control character in %q", errs)
	}
}

// A response that fails validation must leave nothing half-rendered on stdout.
func TestInvalidDataPrintsNothingOnStdout(t *testing.T) {
	isolate(t)
	u := hostileBox(t, `{"ok":true,"request_id":"r","data":{"x":1},"warnings":[]}`, 200)
	code, out, errs := run(t, nil, "--url", u, "status")
	if code != 70 || out != "" {
		t.Fatalf("code %d stdout %q stderr %q", code, out, errs)
	}
}

// 8 MiB of brackets is under the size cap and under the JSON decoder's own
// depth limit's cost model but would make --json print hundreds of MiB of indent.
func TestAbsurdNestingIsRefused(t *testing.T) {
	isolate(t)
	deep := `{"ok":true,"request_id":"r","data":{"x":` + strings.Repeat("[", 5000) + strings.Repeat("]", 5000) + `}}`
	u := hostileBox(t, deep, 200)
	code, out, errs := run(t, nil, "--json", "--url", u, "status")
	if code != 70 || out != "" || !strings.Contains(errs, "nested deeper") {
		t.Fatalf("code %d, stdout len %d, stderr %q", code, len(out), errs)
	}
}
