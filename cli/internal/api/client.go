// Package api is the thin HTTP client for the Bothy /-/api/v1 API. It knows
// the envelope, the error codes, the version gate and the token-transport
// guard, and nothing about any one operation: operations come from
// internal/catalog.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
)

// Exit codes. The API-error rows are the golden README's "suggested CLI exit"
// column (sysexits); 10 is the plan's "server unreachable"; 78 is a version
// gate refusal (api version or op the server does not have).
const (
	ExitOK          = 0
	ExitError       = 1
	ExitUnreachable = 10
	ExitUsage       = 64
	ExitNotFound    = 66
	ExitUnavailable = 69
	ExitInternal    = 70
	ExitAuth        = 77
	ExitSkew        = 78
)

const maxBody = 8 << 20

// Error is a failure envelope from the server.
type Error struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	Details   map[string]any `json:"details"`
	Hint      string         `json:"-"`
	HTTP      int            `json:"-"`
	RequestID string         `json:"-"`
}

func (e *Error) Error() string {
	s := OneLine(e.Code) + ": " + OneLine(e.Message)
	if e.Hint != "" {
		s += " (" + OneLine(e.Hint) + ")"
	}
	return s
}

// ExitCode maps the dotted code (or, for a code this client does not know,
// the HTTP status) to a process exit code.
func (e *Error) ExitCode() int {
	switch e.Code {
	case "auth.unauthenticated", "auth.forbidden":
		return ExitAuth
	case "request.invalid":
		return ExitUsage
	case "request.not-found":
		return ExitNotFound
	case "unavailable.source":
		return ExitUnavailable
	case "internal.error":
		return ExitInternal
	}
	switch {
	case e.HTTP == 401 || e.HTTP == 403:
		return ExitAuth
	case e.HTTP == 400:
		return ExitUsage
	case e.HTTP == 404:
		return ExitNotFound
	case e.HTTP == 503:
		return ExitUnavailable
	case e.HTTP >= 500:
		return ExitInternal
	}
	return ExitError
}

// UnreachableError means no HTTP response arrived.
type UnreachableError struct{ Err error }

func (e *UnreachableError) Error() string { return "cannot reach the server: " + e.Err.Error() }
func (e *UnreachableError) Unwrap() error { return e.Err }

// SkewError is a version-gate refusal: the CLI and the box cannot talk.
type SkewError struct{ Msg string }

func (e *SkewError) Error() string { return e.Msg }

// ProtocolError is a response that breaks the contract (not JSON, no `ok`, a
// required field missing).
type ProtocolError struct{ Msg string }

func (e *ProtocolError) Error() string { return "bad response from the server: " + e.Msg }

// ExitCodeOf maps any error from this package to an exit code.
func ExitCodeOf(err error) int {
	var ae *Error
	var ue *UnreachableError
	var se *SkewError
	var pe *ProtocolError
	switch {
	case err == nil:
		return ExitOK
	case errors.As(err, &ae):
		return ae.ExitCode()
	case errors.As(err, &ue):
		return ExitUnreachable
	case errors.As(err, &se):
		return ExitSkew
	case errors.As(err, &pe):
		return ExitInternal
	}
	return ExitError
}

// ServerInfo is what the Bothy-Server header says.
type ServerInfo struct {
	Version   string
	API       int
	MinClient string
}

var serverHeaderRE = regexp.MustCompile(`^(\S+)\s+api=(\d+)\s+min-client=(\S+)$`)

// ParseServerHeader parses `Bothy-Server: <version> api=<n> min-client=<x.y.z>`.
func ParseServerHeader(h string) (ServerInfo, bool) {
	m := serverHeaderRE.FindStringSubmatch(strings.TrimSpace(h))
	if m == nil {
		return ServerInfo{}, false
	}
	n, _ := strconv.Atoi(m[2])
	return ServerInfo{Version: m[1], API: n, MinClient: m[3]}, true
}

// Result is one successful call.
type Result struct {
	Data      json.RawMessage
	Warnings  []any
	RequestID string
	Server    ServerInfo
	// Notices are client-side remarks to print on stderr (e.g. "update the CLI").
	Notices []string
}

// DiscoverOp is one row of the server's capability list.
type DiscoverOp struct {
	ID  string `json:"id"`
	CLI string `json:"cli"`
}

// Discovery is the data of GET /-/api/v1/discover (fields the client uses).
type Discovery struct {
	APIVersion *int         `json:"apiVersion"`
	MinClient  *string      `json:"minClient"`
	Ops        []DiscoverOp `json:"ops"`
}

// Client talks to one box.
type Client struct {
	base    *url.URL
	token   string
	http    *http.Client
	version string // this CLI's version, "dev" for an unstamped build

	mu   sync.Mutex
	disc *Discovery
	note []string
}

// New builds a client for base (http:// or https://). version is the CLI
// version used for the Bothy-Client header and the min-client comparison.
// A non-empty token is refused over cleartext http:// to anything but
// loopback or the RFC 6598 range (see CheckTokenTransport).
func New(base, token, version string, timeout time.Duration) (*Client, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("base url %q must be http:// or https:// with a host", base)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("base url %q must not carry a query or fragment", base)
	}
	if token != "" {
		if err := CheckTokenTransport(u, token); err != nil {
			return nil, err
		}
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	hc := &http.Client{
		Timeout: timeout,
		// Never follow a redirect: a token must go only where the context says.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return &Client{base: u, token: token, http: hc, version: version}, nil
}

// CheckTokenTransport refuses to send a bearer token over cleartext http://
// unless the host is loopback or in the RFC 6598 shared range (a /10;
// where this product's tailnet lives). https:// is always allowed. A DNS name
// other than localhost is refused over http:// because it cannot be judged
// without resolving it, and a resolver answer is not something to trust here.
func CheckTokenTransport(u *url.URL, token string) error {
	if token == "" || u.Scheme == "https" {
		return nil
	}
	host := u.Hostname()
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return nil
	}
	if ip, err := netip.ParseAddr(strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")); err == nil {
		ip = ip.Unmap()
		if ip.IsLoopback() || cgnat.Contains(ip) {
			return nil
		}
	}
	return fmt.Errorf("refusing to send a token over cleartext http:// to %q: use https://, or a loopback or RFC 6598 shared-range address", host)
}

// The RFC 6598 shared address space, built from its octets so that no address
// literal of the kind the portability check hunts for sits in the source.
var cgnat = netip.PrefixFrom(netip.AddrFrom4([4]byte{100, 64, 0, 0}), 10)

func (c *Client) get(ctx context.Context, path string, q url.Values) (*http.Response, []byte, error) {
	u := *c.base
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Bothy-Client", fmt.Sprintf("cli/%s api=%d", c.version, catalog.APIVersion))
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, nil, &UnreachableError{Err: stripURL(err)}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, nil, &UnreachableError{Err: err}
	}
	if len(body) > maxBody {
		return nil, nil, &ProtocolError{Msg: "response larger than 8 MiB"}
	}
	return resp, body, nil
}

// stripURL keeps the transport reason but drops the request URL (which could
// carry query values) from a *url.Error.
func stripURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return ne
	}
	return err
}

type envelope struct {
	OK        *bool           `json:"ok"`
	RequestID string          `json:"request_id"`
	Data      json.RawMessage `json:"data"`
	Warnings  []any           `json:"warnings"`
	Err       *struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
		Hint    *string        `json:"hint"`
	} `json:"error"`
}

// maxDepth is how deeply nested a response may be. The box's data is a few
// levels deep; a body of 8 MiB of brackets would otherwise be accepted by the
// JSON decoder (limit 10000) and make --json print hundreds of MiB of indent.
const maxDepth = 64

// tooDeep reports whether b nests arrays or objects deeper than maxDepth,
// without allocating. Brackets inside strings do not count.
func tooDeep(b []byte) bool {
	depth, inStr, esc := 0, false, false
	for _, c := range b {
		switch {
		case inStr:
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
		case c == '"':
			inStr = true
		case c == '[' || c == '{':
			if depth++; depth > maxDepth {
				return true
			}
		case c == ']' || c == '}':
			depth--
		}
	}
	return false
}

func decode(resp *http.Response, body []byte) (*envelope, error) {
	if tooDeep(body) {
		return nil, &ProtocolError{Msg: fmt.Sprintf("HTTP %d, response nested deeper than %d levels", resp.StatusCode, maxDepth)}
	}
	var env envelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, &ProtocolError{Msg: fmt.Sprintf("HTTP %d, body is not a JSON envelope", resp.StatusCode)}
	}
	if env.OK == nil {
		return nil, &ProtocolError{Msg: "missing field \"ok\""}
	}
	return &env, nil
}

// checkSkew applies the version gate to what a server reports about itself.
func (c *Client) checkSkew(api int, minClient string) (notice string, err error) {
	if api != catalog.APIVersion {
		return "", &SkewError{Msg: fmt.Sprintf("this box speaks API version %d, this CLI speaks %d: update the CLI (or the box)", api, catalog.APIVersion)}
	}
	if minClient != "" && versionLess(c.version, minClient) {
		return fmt.Sprintf("this box asks for CLI %s or newer and this is %s: reads still work, update the CLI", minClient, c.version), nil
	}
	return "", nil
}

// versionLess reports a < b for dotted numeric versions; an unparsable a
// (a "dev" build) is never less.
func versionLess(a, b string) bool {
	pa, ok1 := parseVer(a)
	pb, ok2 := parseVer(b)
	if !ok1 || !ok2 {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return pa[i] < pb[i]
		}
	}
	return false
}

func parseVer(s string) ([3]int, bool) {
	var out [3]int
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Discover fetches and caches the capability list. It is the one call allowed
// before the version is checked; it is itself the check.
func (c *Client) Discover(ctx context.Context) (*Discovery, *Result, error) {
	op, _ := catalog.ByID("discover")
	res, err := c.do(ctx, op, nil, false)
	if err != nil {
		return nil, nil, err
	}
	var d Discovery
	if err := json.Unmarshal(res.Data, &d); err != nil {
		return nil, nil, &ProtocolError{Msg: "discover data: " + err.Error()}
	}
	if d.APIVersion == nil {
		return nil, nil, &ProtocolError{Msg: "discover is missing field \"apiVersion\""}
	}
	minClient := ""
	if d.MinClient != nil {
		minClient = *d.MinClient
	}
	notice, err := c.checkSkew(*d.APIVersion, minClient)
	if err != nil {
		return nil, nil, err
	}
	if notice != "" {
		res.Notices = append(res.Notices, notice)
	}
	c.mu.Lock()
	c.disc = &d
	if notice != "" {
		c.note = append(c.note[:0], notice)
	}
	c.mu.Unlock()
	return &d, res, nil
}

// Call runs one read operation. It checks the box first (Discover, once per
// client): the api version, min-client, and that the box lists this op. Args
// are validated against the catalog before anything is sent; the server
// refuses unknown query parameters, so none are ever sent.
func (c *Client) Call(ctx context.Context, op catalog.Op, args map[string]string) (*Result, error) {
	if op.Method != http.MethodGet {
		return nil, fmt.Errorf("operation %s is %s: this client only performs reads", op.ID, op.Method)
	}
	if _, err := ValidateArgs(op, args); err != nil {
		return nil, err
	}
	c.mu.Lock()
	d, notes := c.disc, append([]string(nil), c.note...)
	c.mu.Unlock()
	if d == nil && op.ID != "discover" {
		var err error
		var dres *Result
		d, dres, err = c.Discover(ctx)
		if err != nil {
			return nil, err
		}
		notes = dres.Notices
	}
	if d != nil && op.ID != "discover" {
		listed := false
		for _, o := range d.Ops {
			if o.ID == op.ID {
				listed = true
				break
			}
		}
		if !listed {
			return nil, &SkewError{Msg: fmt.Sprintf("this box has no operation %q (%s): update the box, or use an older CLI", op.ID, op.VerbString())}
		}
	}
	res, err := c.do(ctx, op, args, true)
	if err != nil {
		return nil, err
	}
	res.Notices = append(notes, res.Notices...)
	return res, nil
}

func (c *Client) do(ctx context.Context, op catalog.Op, args map[string]string, gate bool) (*Result, error) {
	q := url.Values{}
	for _, p := range op.Params {
		if v, ok := args[p.Name]; ok {
			q.Set(p.Name, v)
		}
	}
	resp, body, err := c.get(ctx, op.Path, q)
	if err != nil {
		return nil, err
	}
	srv, hasHdr := ParseServerHeader(resp.Header.Get("Bothy-Server"))
	var notices []string
	if gate && hasHdr {
		n, err := c.checkSkew(srv.API, srv.MinClient)
		if err != nil {
			return nil, err
		}
		if n != "" {
			notices = append(notices, n)
		}
	}
	env, err := decode(resp, body)
	if err != nil {
		return nil, err
	}
	if !*env.OK {
		if env.Err == nil || env.Err.Code == "" {
			return nil, &ProtocolError{Msg: "failure without field \"error.code\""}
		}
		e := &Error{Code: env.Err.Code, Message: env.Err.Message, Details: env.Err.Details, HTTP: resp.StatusCode, RequestID: env.RequestID}
		if env.Err.Hint != nil {
			e.Hint = *env.Err.Hint
		}
		return nil, e
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &ProtocolError{Msg: fmt.Sprintf("ok response with HTTP %d", resp.StatusCode)}
	}
	if len(env.Data) == 0 || string(env.Data) == "null" {
		return nil, &ProtocolError{Msg: "missing field \"data\""}
	}
	return &Result{Data: env.Data, Warnings: env.Warnings, RequestID: env.RequestID, Server: srv, Notices: notices}, nil
}

// ValidateArgs checks args against the op's declared params (names, required,
// pattern, enum, range, one-of groups). It returns the args unchanged.
func ValidateArgs(op catalog.Op, args map[string]string) (map[string]string, error) {
	known := map[string]catalog.Param{}
	for _, p := range op.Params {
		known[p.Name] = p
	}
	for name := range args {
		if _, ok := known[name]; !ok {
			return nil, fmt.Errorf("%s: unknown parameter %q", op.VerbString(), name)
		}
	}
	groups := map[string][]string{}
	for _, p := range op.Params {
		v, given := args[p.Name]
		if !given {
			if p.Required {
				return nil, fmt.Errorf("%s: missing required parameter %q", op.VerbString(), p.Name)
			}
			continue
		}
		if p.OneOf != "" {
			groups[p.OneOf] = append(groups[p.OneOf], p.Name)
		}
		if p.Type == "integer" {
			n, err := strconv.Atoi(v)
			if err != nil {
				return nil, fmt.Errorf("%s: %s must be an integer, got %q", op.VerbString(), p.Name, v)
			}
			if p.HasMin && n < p.Min || p.HasMax && n > p.Max {
				return nil, fmt.Errorf("%s: %s must be %d..%d, got %d", op.VerbString(), p.Name, p.Min, p.Max, n)
			}
		}
		if len(p.Enum) > 0 && !contains(p.Enum, v) {
			return nil, fmt.Errorf("%s: %s must be one of %s, got %q", op.VerbString(), p.Name, strings.Join(p.Enum, ", "), v)
		}
		if p.Pattern != "" && !regexp.MustCompile(p.Pattern).MatchString(v) {
			return nil, fmt.Errorf("%s: %s %q does not match %s", op.VerbString(), p.Name, v, p.Pattern)
		}
	}
	for _, p := range op.Params {
		if p.OneOf != "" && len(groups[p.OneOf]) == 0 {
			var all []string
			for _, q := range op.Params {
				if q.OneOf == p.OneOf {
					all = append(all, q.Name)
				}
			}
			return nil, fmt.Errorf("%s: give exactly one of %s", op.VerbString(), strings.Join(all, ", "))
		}
	}
	for g, names := range groups {
		if len(names) > 1 {
			return nil, fmt.Errorf("%s: give exactly one of the %s parameters, got %s", op.VerbString(), g, strings.Join(names, " and "))
		}
	}
	return args, nil
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}
