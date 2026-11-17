// Package tokens mints, lists and revokes bearer tokens ON THE HOST, by writing the file
// bothy-ops reads (apps/bothy-ops/tokenstore.py, decision D43). There is no network code in
// this package and no route to it: minting through the API would let any credential that can
// reach the API make a stronger one. The file format is the Python store's; a golden fixture
// (testdata/gotokens.golden.json, replayed by apps/bothy-ops/checks/test_tokens.py) holds the
// two languages to it.
//
//	token   bt_<id>.<secret>   id = 16 hex, secret = 256 random bits, unpadded urlsafe base64 (43)
//	file    <state>/tokens.json  mode 0600 in a 0700 directory owned by the caller, never a symlink
//	disk    only the SHA-256 digest of the secret; the secret is returned once and never logged
package tokens

import (
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

const (
	AllOps     = "*"
	DefaultTTL = 30 * 24 * time.Hour
	MaxTTL     = 365 * 24 * time.Hour
	MinTTL     = time.Minute
	MaxRecords = 2000
	maxFile    = 1 << 20

	FileName  = "tokens.json"
	LockName  = "tokens.lock"
	AuditName = "audit.log"
)

var (
	Kinds = []string{"cli", "mcp"}
	Roles = []string{"viewer", "operator"}

	idRE     = regexp.MustCompile(`^[0-9a-f]{16}$`)
	digestRE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	nameRE   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._@:-]{0,63}$`)
	opRE     = regexp.MustCompile(`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$`)
	// TokenRE is the one shape of a token; the CLI refuses to send anything else.
	TokenRE = regexp.MustCompile(`^bt_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$`)
)

// ErrUnsupported is returned on a platform with no host store (Windows).
var ErrUnsupported = errors.New("token minting is supported on Linux and macOS hosts only")

// Record is one token, without its secret in it. Times are epoch seconds.
type Record struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Role      string   `json:"role"`
	Ops       []string `json:"ops"`
	Created   int64    `json:"created"`
	Expires   int64    `json:"expires"`
	Name      string   `json:"name"`
	RevokedAt *int64   `json:"revoked_at"`
	LastUsed  *int64   `json:"last_used"`
	Digest    string   `json:"digest"`
}

// Public is a record with its digest blanked: the only form that is ever printed.
type Public struct {
	Record
	Status string
}

// Spec is what `create` asks for.
type Spec struct {
	Kind, Role, Name string
	Ops              []string
	TTL              time.Duration
}

type doc struct {
	Version int      `json:"version"`
	Tokens  []Record `json:"tokens"`
}

// Env is everything a test needs to control.
type Env struct {
	Now func() time.Time // default time.Now
	// Rand is the entropy source; default crypto/rand. A test fixes it; production never does.
	Rand io.Reader
	// KnownOp reports whether an op id exists in the catalog (a token may only name real ops).
	KnownOp func(string) bool
}

func (e Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func validRecord(r Record) bool {
	if !idRE.MatchString(r.ID) || !contains(Kinds, r.Kind) || !contains(Roles, r.Role) || !digestRE.MatchString(r.Digest) || len(r.Ops) == 0 {
		return false
	}
	for _, o := range r.Ops {
		if o != AllOps && !opRE.MatchString(o) {
			return false
		}
	}
	return true
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// StatusOf is "revoked", "expired" or "active" at time now.
func StatusOf(r Record, now time.Time) string {
	switch {
	case r.RevokedAt != nil:
		return "revoked"
	case now.Unix() >= r.Expires:
		return "expired"
	}
	return "active"
}

func validateSpec(s Spec, known func(string) bool) error {
	if !contains(Kinds, s.Kind) || !contains(Roles, s.Role) {
		return errors.New("kind must be cli or mcp and role viewer or operator")
	}
	if !nameRE.MatchString(s.Name) {
		return errors.New("--name must be 1-64 letters, digits, space or . _ @ : - and start with a letter or digit")
	}
	if len(s.Ops) == 0 {
		return errors.New("--ops is a list of op ids without repeats, or just '*'")
	}
	seen := map[string]bool{}
	for _, o := range s.Ops {
		if seen[o] || (o == AllOps && len(s.Ops) > 1) {
			return errors.New("--ops is a list of op ids without repeats, or just '*'")
		}
		seen[o] = true
	}
	if s.Ops[0] != AllOps {
		var bad []string
		for _, o := range s.Ops {
			if known == nil || !known(o) {
				bad = append(bad, o)
			}
		}
		if len(bad) > 0 {
			return fmt.Errorf("unknown op id(s): %s", strings.Join(bad, ", "))
		}
	}
	if s.TTL < MinTTL || s.TTL > MaxTTL {
		return fmt.Errorf("ttl must be between %s and %d days", MinTTL, int(MaxTTL.Hours()/24))
	}
	return nil
}
