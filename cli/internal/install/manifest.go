package install

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Manifest is release-manifest.json, published next to the binary by the
// release. Every image is referenced by digest; there is no tag in it.
type Manifest struct {
	Schema     int                   `json:"schema"`
	Version    string                `json:"version"`
	Commit     string                `json:"commit"`
	Images     map[string]ImageEntry `json:"images"`
	ThirdParty map[string]ImageEntry `json:"third_party"`
	Assets     map[string]string     `json:"assets"`
}

type ImageEntry struct {
	Ref       string   `json:"ref"`
	Platforms []string `json:"platforms,omitempty"`
}

var (
	// [registry[:port]/]path[:tag]@sha256:<64 hex>, lower case. A tag may ride
	// along (the digest is what binds); a reference WITHOUT a digest is refused.
	refRe    = regexp.MustCompile(`^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}$`)
	commitRe = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// ParseManifest decodes and validates. Unknown fields are refused: a manifest
// this binary does not fully understand is not one it may act on.
func ParseManifest(b []byte) (*Manifest, error) {
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("release manifest: %w", err)
	}
	if m.Schema != 1 {
		return nil, fmt.Errorf("release manifest: schema %d is not supported by this binary (want 1)", m.Schema)
	}
	if m.Version == "" {
		return nil, fmt.Errorf("release manifest: no version")
	}
	if !commitRe.MatchString(m.Commit) {
		return nil, fmt.Errorf("release manifest: commit %q is not a 40-hex sha", m.Commit)
	}
	for _, set := range []map[string]ImageEntry{m.Images, m.ThirdParty} {
		for name, e := range set {
			if !refRe.MatchString(e.Ref) {
				return nil, fmt.Errorf("release manifest: %s: %q is not a digest reference (registry/name@sha256:<64 hex>); tags are refused", name, e.Ref)
			}
		}
	}
	return &m, nil
}

// Lookup finds the digest reference for a stack service's image.
func (m *Manifest) Lookup(key string, own bool) (string, error) {
	set, label := m.ThirdParty, "third_party"
	if own {
		set, label = m.Images, "images"
	}
	e, ok := set[key]
	if !ok {
		return "", fmt.Errorf("the release manifest has no %s entry for %q", label, key)
	}
	return e.Ref, nil
}

// ChecksumFor returns the sha256 that a goreleaser-style checksums.txt
// ("<hex>  <name>") lists for name.
func ChecksumFor(checksums []byte, name string) (string, error) {
	sc := bufio.NewScanner(bytes.NewReader(checksums))
	found := ""
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			if found != "" {
				return "", fmt.Errorf("checksums.txt lists %s twice", name)
			}
			found = strings.ToLower(f[0])
		}
	}
	if found == "" {
		return "", fmt.Errorf("checksums.txt has no line for %s", name)
	}
	if len(found) != 64 {
		return "", fmt.Errorf("checksums.txt: %s has a malformed checksum", name)
	}
	return found, nil
}

// VerifyManifest is the whole trust decision for what gets pulled:
//
//  1. the manifest's sha256 must equal its line in checksums.txt (which the
//     release attests; verifying the attestation itself is the caller's job);
//  2. when the binary was built with a pinned manifest sha (ldflags), that
//     must match too;
//  3. the manifest's version must equal the binary's version (a "dev" binary
//     is refused: it has no release to install).
func VerifyManifest(manifest, checksums []byte, binaryVersion, pinnedSHA string) (*Manifest, string, error) {
	sum := sha256.Sum256(manifest)
	got := hex.EncodeToString(sum[:])
	want, err := ChecksumFor(checksums, "release-manifest.json")
	if err != nil {
		return nil, got, err
	}
	if got != want {
		return nil, got, fmt.Errorf("release-manifest.json does not match checksums.txt (got %s, checksums say %s): refusing to install", got, want)
	}
	if pinnedSHA != "" && got != pinnedSHA {
		return nil, got, fmt.Errorf("release-manifest.json does not match the sha256 pinned into this binary (%s): refusing to install", pinnedSHA)
	}
	m, err := ParseManifest(manifest)
	if err != nil {
		return nil, got, err
	}
	if binaryVersion == "dev" || binaryVersion == "" {
		return nil, got, fmt.Errorf("this is a development build of bothy (version %q): it has no release to install. Download a release binary", binaryVersion)
	}
	if strings.TrimPrefix(m.Version, "v") != strings.TrimPrefix(binaryVersion, "v") {
		return nil, got, fmt.Errorf("the manifest is for version %s but this binary is %s: bothy installs exactly the release it belongs to", m.Version, binaryVersion)
	}
	return m, got, nil
}

// Fetch reads a local path, a file:// URL or an https:// URL (capped at 1 MiB:
// a manifest is small, and an endless body must not fill memory).
func Fetch(src string) ([]byte, error) {
	const limit = 1 << 20
	u, err := url.Parse(src)
	if err == nil && u.Scheme == "https" {
		c := &http.Client{Timeout: 30 * time.Second}
		resp, err := c.Get(src)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("GET %s: %s", src, resp.Status)
		}
		return readCapped(resp.Body, limit)
	}
	if err == nil && u.Scheme == "http" {
		return nil, fmt.Errorf("%s: plain http is refused for release metadata", src)
	}
	path := strings.TrimPrefix(src, "file://")
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return readCapped(f, limit)
}

func readCapped(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("response larger than %d bytes", limit)
	}
	return b, nil
}

// Digests lists the manifest's image refs a stack needs, sorted, for printing.
func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
