// Package testkit serves the Python-generated golden files as a fake Bothy
// server. It is for tests only. The goldens are the contract and are never
// edited from here (checks/golden/v1/README.md).
package testkit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

// GoldenDir is the golden directory relative to a package two levels under cli/.
const GoldenDir = "../../../apps/bothy-ops/checks/golden/v1"

// Golden is one recorded exchange.
type Golden struct {
	Name         string
	Method, Path string // Path includes the query
	Status       int
	ServerHeader string
	Body         json.RawMessage
	Env          struct {
		OK    bool            `json:"ok"`
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
}

// Goldens loads every golden file, in name order.
func Goldens(t testing.TB) []Golden {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(GoldenDir, "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no golden files under %s: %v", GoldenDir, err)
	}
	sort.Strings(files)
	var out []Golden
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var raw struct {
			Request struct{ Method, Path string } `json:"request"`
			Status  int                           `json:"status"`
			Server  string                        `json:"server_header"`
			Body    json.RawMessage               `json:"body"`
		}
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		g := Golden{Name: strings.TrimSuffix(filepath.Base(f), ".json"), Method: raw.Request.Method, Path: raw.Request.Path,
			Status: raw.Status, ServerHeader: raw.Server, Body: raw.Body}
		if err := json.Unmarshal(raw.Body, &g.Env); err != nil {
			t.Fatalf("%s: body: %v", f, err)
		}
		out = append(out, g)
	}
	return out
}

// Named returns the golden with the given file stem.
func Named(t testing.TB, name string) Golden {
	t.Helper()
	for _, g := range Goldens(t) {
		if g.Name == name {
			return g
		}
	}
	t.Fatalf("no golden %q", name)
	return Golden{}
}

// Server is a fake box. Requests are matched on path and parsed query; each
// distinct match is answered from its golden. Hooks let a test bend the answer.
type Server struct {
	*httptest.Server
	mu       sync.Mutex
	Requests []*http.Request // every request received, in order
	routes   map[string]Golden
	// Header overrides the Bothy-Server header when non-empty.
	Header string
	// Mutate, if set, may rewrite the body served for a path (no query).
	Mutate func(path string, body []byte) []byte
	// Auth records the Authorization header of the last request.
	Auth string
}

// NewServer serves all goldens whose request is a GET.
func NewServer(t testing.TB) *Server {
	t.Helper()
	s := &Server{routes: map[string]Golden{}}
	for _, g := range Goldens(t) {
		if g.Method != "GET" {
			continue
		}
		s.routes[key(g.Path)] = g
	}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	return s
}

func key(pathAndQuery string) string {
	u, _ := url.Parse(pathAndQuery)
	q := u.Query()
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{u.Path}
	for _, k := range keys {
		parts = append(parts, k+"="+strings.Join(q[k], ","))
	}
	return strings.Join(parts, "|")
}

// Paths returns how many requests hit a path (no query).
func (s *Server) Paths(path string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, r := range s.Requests {
		if r.URL.Path == path {
			n++
		}
	}
	return n
}

// Last returns the most recent request.
func (s *Server) Last() *http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.Requests) == 0 {
		return nil
	}
	return s.Requests[len(s.Requests)-1]
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.Requests = append(s.Requests, r.Clone(r.Context()))
	s.Auth = r.Header.Get("Authorization")
	s.mu.Unlock()
	g, ok := s.routes[key(r.URL.RequestURI())]
	hdr := "2026.11.0 api=1 min-client=0.0.0"
	if s.Header != "" {
		hdr = s.Header
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Bothy-Server", hdr)
	w.Header().Set("X-Request-Id", "r_0000000000000000")
	if !ok {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"ok":false,"request_id":"r_0000000000000000","error":{"code":"request.not-found","message":"no such operation (fake: no golden for this request)","details":{},"hint":null}}`))
		return
	}
	body := []byte(g.Body)
	if s.Mutate != nil {
		body = s.Mutate(r.URL.Path, body)
	}
	w.WriteHeader(g.Status)
	_, _ = w.Write(body)
}

// QueryOf returns the parsed query of the last request.
func (s *Server) QueryOf() url.Values {
	if r := s.Last(); r != nil {
		return r.URL.Query()
	}
	return nil
}

// Same reports deep equality, for tests.
func Same(a, b any) bool { return reflect.DeepEqual(a, b) }
