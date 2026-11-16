package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/api"
	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

func newClient(t *testing.T, s *testkit.Server, version string) *api.Client {
	t.Helper()
	c, err := api.New(s.URL, "", version, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// Every golden request, replayed through the client, must decode: success
// envelopes yield data, failure envelopes yield an *api.Error whose code is
// the golden's and whose exit code is the README table's.
func TestEveryGoldenDecodes(t *testing.T) {
	exitFor := map[string]int{
		"request.invalid":   64,
		"request.not-found": 66,
		"auth.forbidden":    77,
	}
	for _, g := range testkit.Goldens(t) {
		if g.Method != "GET" {
			continue // the client never sends a write; error.write-refused is covered below
		}
		t.Run(g.Name, func(t *testing.T) {
			s := testkit.NewServer(t)
			c := newClient(t, s, "2026.11.0")
			u, _ := url.Parse(g.Path)
			var op catalog.Op
			for _, o := range catalog.Ops {
				if o.Path == u.Path {
					op = o
				}
			}
			args := map[string]string{}
			for k, v := range u.Query() {
				args[k] = v[0]
			}
			if op.ID == "" {
				// An unknown path: send it through the transport the way a stale CLI would.
				op = catalog.Op{ID: "nothing", Method: "GET", Path: u.Path, Verb: []string{"nothing"}}
				_, err := c.Call(context.Background(), op, args)
				var se *api.SkewError
				if !errors.As(err, &se) {
					t.Fatalf("op the box does not list: want SkewError (discover gate), got %v", err)
				}
				return
			}
			res, err := c.Call(context.Background(), op, args)
			if g.Env.OK {
				if err != nil {
					t.Fatal(err)
				}
				if len(res.Data) == 0 {
					t.Fatal("no data")
				}
				return
			}
			var ae *api.Error
			if g.Name == "error.invalid" {
				// The server refuses component+group together; the client
				// refuses it first, so the request never leaves the machine.
				if err == nil || errors.As(err, &ae) || !strings.Contains(err.Error(), "exactly one") {
					t.Fatalf("want a client-side one-of refusal, got %v", err)
				}
				return
			}
			if !errors.As(err, &ae) {
				t.Fatalf("want *api.Error, got %v", err)
			}
			if ae.Code != g.Env.Error.Code || ae.HTTP != g.Status {
				t.Fatalf("got %s/%d, want %s/%d", ae.Code, ae.HTTP, g.Env.Error.Code, g.Status)
			}
			if want, ok := exitFor[ae.Code]; ok && ae.ExitCode() != want {
				t.Fatalf("exit %d, want %d", ae.ExitCode(), want)
			}
		})
	}
}

func TestExitCodeTable(t *testing.T) {
	for _, tc := range []struct {
		code string
		http int
		want int
	}{
		{"auth.unauthenticated", 401, 77}, {"auth.forbidden", 403, 77}, {"request.invalid", 400, 64},
		{"request.not-found", 404, 66}, {"unavailable.source", 503, 69}, {"internal.error", 500, 70},
		// A code this client does not know falls back to the HTTP status.
		{"busy.job-running", 409, 1}, {"plan.stale", 503, 69}, {"rate.limited", 429, 1}, {"x.y", 404, 66},
	} {
		if got := (&api.Error{Code: tc.code, HTTP: tc.http}).ExitCode(); got != tc.want {
			t.Errorf("%s/%d: exit %d, want %d", tc.code, tc.http, got, tc.want)
		}
	}
}

func TestWriteRefusedGoldenIsAnAuthError(t *testing.T) {
	g := testkit.Named(t, "error.write-refused")
	if g.Method != "POST" || g.Env.Error.Code != "auth.forbidden" {
		t.Fatalf("golden changed: %s %s", g.Method, g.Env.Error.Code)
	}
}

func TestClientNeverSendsAWriteOrAnUnknownParam(t *testing.T) {
	s := testkit.NewServer(t)
	c := newClient(t, s, "dev")
	op, _ := catalog.ByID("update.plan")
	if _, err := c.Call(context.Background(), op, map[string]string{"component": "solo", "bogus": "1"}); err == nil || !strings.Contains(err.Error(), "unknown parameter") {
		t.Fatalf("want unknown parameter, got %v", err)
	}
	if _, err := c.Call(context.Background(), op, map[string]string{"component": "solo", "group": "up-mon"}); err == nil {
		t.Fatal("both component and group must be refused client-side")
	}
	if _, err := c.Call(context.Background(), op, nil); err == nil {
		t.Fatal("neither component nor group must be refused client-side")
	}
	if n := s.Paths("/-/api/v1/updates/plan"); n != 0 {
		t.Fatalf("invalid calls reached the box %d times", n)
	}
	post := catalog.Op{ID: "x", Method: "POST", Path: "/-/api/v1/x", Verb: []string{"x"}}
	if _, err := c.Call(context.Background(), post, nil); err == nil {
		t.Fatal("a POST op must be refused by the client")
	}
	for _, r := range s.Requests {
		if r.Method != http.MethodGet {
			t.Fatalf("sent %s", r.Method)
		}
	}
}

func TestHeadersSent(t *testing.T) {
	s := testkit.NewServer(t)
	c := newClient(t, s, "2026.11.0")
	op, _ := catalog.ByID("status")
	if _, err := c.Call(context.Background(), op, nil); err != nil {
		t.Fatal(err)
	}
	if got := s.Last().Header.Get("Bothy-Client"); got != "cli/2026.11.0 api=1" {
		t.Fatalf("Bothy-Client %q", got)
	}
}

func TestUnknownFieldsAreIgnoredMissingRequiredFieldsFail(t *testing.T) {
	s := testkit.NewServer(t)
	s.Mutate = func(path string, body []byte) []byte {
		if path != "/-/api/v1/status" {
			return body
		}
		// additive change: a new envelope field and a new data field
		return []byte(strings.Replace(string(body), `"ok": true`, `"ok": true, "future": {"x": 1}`, 1))
	}
	c := newClient(t, s, "dev")
	op, _ := catalog.ByID("status")
	if _, err := c.Call(context.Background(), op, nil); err != nil {
		t.Fatalf("unknown envelope field must be tolerated: %v", err)
	}
	s.Mutate = func(path string, body []byte) []byte {
		if path == "/-/api/v1/status" {
			return []byte(`{"request_id":"r_0000000000000000","data":{}}`) // no "ok"
		}
		return body
	}
	_, err := c.Call(context.Background(), op, nil)
	var pe *api.ProtocolError
	if !errors.As(err, &pe) || !strings.Contains(err.Error(), `"ok"`) {
		t.Fatalf("want ProtocolError naming ok, got %v", err)
	}
	if api.ExitCodeOf(err) != api.ExitInternal {
		t.Fatalf("exit %d", api.ExitCodeOf(err))
	}
}

func TestVersionGate(t *testing.T) {
	op, _ := catalog.ByID("status")
	ctx := context.Background()

	t.Run("api version above the CLI's refuses", func(t *testing.T) {
		s := testkit.NewServer(t)
		s.Mutate = func(p string, b []byte) []byte {
			if p == "/-/api/v1/discover" {
				return []byte(strings.Replace(string(b), `"apiVersion": 1`, `"apiVersion": 2`, 1))
			}
			return b
		}
		_, err := newClient(t, s, "dev").Call(ctx, op, nil)
		var se *api.SkewError
		if !errors.As(err, &se) || api.ExitCodeOf(err) != api.ExitSkew {
			t.Fatalf("want SkewError/78, got %v", err)
		}
		if s.Paths("/-/api/v1/status") != 0 {
			t.Fatal("the op was sent past a failed gate")
		}
	})

	t.Run("api version in the response header above the CLI's refuses", func(t *testing.T) {
		s := testkit.NewServer(t)
		s.Header = "2027.1.0 api=2 min-client=0.0.0"
		_, err := newClient(t, s, "dev").Call(ctx, op, nil)
		var se *api.SkewError
		if !errors.As(err, &se) {
			t.Fatalf("want SkewError, got %v", err)
		}
	})

	t.Run("min-client above the CLI: reads continue with a notice", func(t *testing.T) {
		s := testkit.NewServer(t)
		s.Mutate = func(p string, b []byte) []byte {
			if p == "/-/api/v1/discover" {
				return []byte(strings.Replace(string(b), `"minClient": "0.0.0"`, `"minClient": "2099.1.0"`, 1))
			}
			return b
		}
		res, err := newClient(t, s, "2026.11.0").Call(ctx, op, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Notices) == 0 || !strings.Contains(res.Notices[0], "update the CLI") {
			t.Fatalf("want an update-the-CLI notice, got %v", res.Notices)
		}
	})

	t.Run("a dev build never trips min-client", func(t *testing.T) {
		s := testkit.NewServer(t)
		s.Header = "2026.11.0 api=1 min-client=2099.1.0"
		res, err := newClient(t, s, "dev").Call(ctx, op, nil)
		if err != nil || len(res.Notices) != 0 {
			t.Fatalf("err=%v notices=%v", err, res.Notices)
		}
	})

	t.Run("an op the box does not list is refused before it is sent", func(t *testing.T) {
		s := testkit.NewServer(t)
		s.Mutate = func(p string, b []byte) []byte {
			if p == "/-/api/v1/discover" {
				return []byte(strings.Replace(string(b), `"id": "status"`, `"id": "status.renamed"`, 1))
			}
			return b
		}
		_, err := newClient(t, s, "dev").Call(ctx, op, nil)
		var se *api.SkewError
		if !errors.As(err, &se) || !strings.Contains(err.Error(), "no operation") {
			t.Fatalf("want SkewError naming the op, got %v", err)
		}
		if s.Paths("/-/api/v1/status") != 0 {
			t.Fatal("sent an op the box does not list")
		}
	})

	t.Run("discover is checked once per client", func(t *testing.T) {
		s := testkit.NewServer(t)
		c := newClient(t, s, "dev")
		for i := 0; i < 3; i++ {
			if _, err := c.Call(ctx, op, nil); err != nil {
				t.Fatal(err)
			}
		}
		if n := s.Paths("/-/api/v1/discover"); n != 1 {
			t.Fatalf("discover called %d times", n)
		}
	})
}

func TestParseServerHeader(t *testing.T) {
	h, ok := api.ParseServerHeader("2026.11.0 api=1 min-client=0.0.0")
	if !ok || h.Version != "2026.11.0" || h.API != 1 || h.MinClient != "0.0.0" {
		t.Fatalf("%+v %v", h, ok)
	}
	if _, ok := api.ParseServerHeader("garbage"); ok {
		t.Fatal("garbage parsed")
	}
}

func TestTokenTransportGuard(t *testing.T) {
	for _, tc := range []struct {
		url   string
		token string
		ok    bool
	}{
		{"http://127.0.0.1:8080", "t", true},
		{"http://127.9.9.9", "t", true},
		{"http://[::1]:8080", "t", true},
		{"http://localhost:8080", "t", true},
		{"http://100.64.0.1:80", "t", true},      // RFC 6598 low edge
		{"http://100.127.255.254:80", "t", true}, // RFC 6598 high edge
		{"http://100.63.255.255", "t", false},
		{"http://100.128.0.1", "t", false},
		{"http://192.168.1.10", "t", false},
		{"http://10.0.0.5", "t", false},
		{"http://example.com", "t", false},
		{"http://localhost.evil.example", "t", false},
		{"http://127.0.0.1.evil.example", "t", false},
		{"https://example.com", "t", true},
		{"http://192.168.1.10", "", true}, // no token, nothing to protect
	} {
		_, err := api.New(tc.url, tc.token, "dev", 0)
		if (err == nil) != tc.ok {
			t.Errorf("%s token=%q: err=%v, want ok=%v", tc.url, tc.token, err, tc.ok)
		}
	}
	u, _ := url.Parse("http://203.0.113.7")
	if err := api.CheckTokenTransport(u, "x"); err == nil || !strings.Contains(err.Error(), "cleartext") {
		t.Fatalf("got %v", err)
	}
}

// A token is sent only where the context says: a redirect is never followed.
func TestTokenNotSentOnRedirect(t *testing.T) {
	var leaked string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = r.Header.Get("Authorization") }))
	defer other.Close()
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusFound)
	}))
	defer first.Close()
	c, err := api.New(first.URL, "secret-token", "dev", 0) // 127.0.0.1: allowed
	if err != nil {
		t.Fatal(err)
	}
	op, _ := catalog.ByID("discover")
	if _, err := c.Call(context.Background(), op, nil); err == nil {
		t.Fatal("a redirect must not look like success")
	}
	if leaked != "" {
		t.Fatalf("token followed a redirect: %q", leaked)
	}
}

func TestTokenSentAsBearer(t *testing.T) {
	s := testkit.NewServer(t)
	c, err := api.New(s.URL, "tok-123", "dev", 0)
	if err != nil {
		t.Fatal(err)
	}
	op, _ := catalog.ByID("discover")
	if _, err := c.Call(context.Background(), op, nil); err != nil {
		t.Fatal(err)
	}
	if s.Auth != "Bearer tok-123" {
		t.Fatalf("Authorization %q", s.Auth)
	}
}

func TestUnreachable(t *testing.T) {
	s := testkit.NewServer(t)
	url := s.URL
	s.Close()
	c, _ := api.New(url, "", "dev", time.Second)
	op, _ := catalog.ByID("status")
	_, err := c.Call(context.Background(), op, nil)
	if api.ExitCodeOf(err) != api.ExitUnreachable {
		t.Fatalf("exit %d for %v", api.ExitCodeOf(err), err)
	}
	if strings.Contains(err.Error(), "/-/api/") {
		t.Fatalf("transport error leaks the request URL: %v", err)
	}
}

func TestSanitize(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"plain", "plain"},
		{"keep\nnewline\tand tab", "keep\nnewline\tand tab"},
		{"\x1b[2J\x1b[Hcleared", "cleared"},                       // clear screen
		{"a\x1b]0;evil title\x07b", "ab"},                         // OSC with BEL
		{"a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\b", "alinkb"}, // OSC 8 hyperlink with ST
		{"a\x1bPq#0;2;0;0;0\x1b\\b", "ab"},                        // DCS
		{"a\u009b31mred\u009bm", "ared"},                          // 8-bit CSI
		{"a\u202eevil\u202cb", "aevilb"},                          // bidi override
		{"a\u2066x\u2069b", "axb"},                                // bidi isolate
		{"a\x00b\x07c\x7fd\u0085e", "abcde"},                      // controls incl. C1
		{"zero\u200bwidth\ufeff", "zerowidth"},
		{"\x1b", ""},
		{"trailing \x1b[", "trailing "},
	} {
		if got := api.Sanitize(tc.in); got != tc.want {
			t.Errorf("Sanitize(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := api.OneLine("a\n\tb   c"); got != "a b c" {
		t.Fatalf("OneLine %q", got)
	}
}
