package install

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Packager is stamped by a distributor's build
// (-ldflags "-X github.com/YehudaBriskman/Bothy/cli/internal/install.Packager=deb").
// Non-empty means a package manager owns this binary: `bothy update` still
// reports whether a newer release exists (--check) but never replaces the
// binary itself, and says to use that package manager. Empty for the release
// archives, which are the only build that updates itself.
var Packager = ""

// Release discovery and the binary self-update (distribution-and-packaging.md
// D34, bothy-install.md section 8b).
//
// WHAT THE GITHUB API IS TRUSTED FOR: ONE STRING, the tag. Every URL that is
// fetched afterwards is BUILT here from that tag (DownloadBase/<tag>/<asset>),
// never taken from the API response, so a hostile response cannot send the
// download to another host. The tag is validated as a strict stable CalVer,
// so it cannot carry a path or a query. Everything else comes from the release
// itself and is verified by the same path install uses (VerifyManifest, the
// hash line in checksums.txt, checkAttestation), plus the sha256 of the archive
// against its checksums.txt line. See the trust section of bothy-install.md.

// Source is where releases are discovered and downloaded. Production uses
// DefaultSource; tests point both at an httptest TLS server.
type Source struct {
	API      string       // "https://api.github.com"
	Download string       // "https://github.com/OWNER/REPO/releases/download"
	HTTP     *http.Client // nil: a default client; the caller's context bounds each call
}

func DefaultSource() Source {
	return Source{API: "https://api.github.com", Download: "https://github.com/" + AttestRepo + "/releases/download"}
}

func (s Source) client() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return &http.Client{}
}

// RateLimitError is GitHub refusing an unauthenticated caller (60 requests an
// hour per address). It is not "no release": the caller may retry later.
type RateLimitError struct{ Reset time.Time }

func (e *RateLimitError) Error() string {
	if e.Reset.IsZero() {
		return "GitHub rate-limited this address (unauthenticated API calls are limited to 60 an hour); try again later"
	}
	return fmt.Sprintf("GitHub rate-limited this address (unauthenticated API calls are limited to 60 an hour); try again after %s", e.Reset.Local().Format("15:04 MST"))
}

// OfflineError is a transport failure: DNS, refused, timeout, TLS.
type OfflineError struct{ Err error }

func (e *OfflineError) Error() string {
	return fmt.Sprintf("cannot reach GitHub (offline, or a proxy/firewall in the way?): %v. Nothing was changed; `bothy update --this-release` re-applies this binary's own release without asking GitHub", e.Err)
}
func (e *OfflineError) Unwrap() error { return e.Err }

// CalVer is the project's version, YYYY.M.N (scripts/checks/version.sh holds
// the same rule): year, month 1-12, patch counter. No prerelease suffix exists
// in the scheme, so "2026.11.1-rc1" is NOT a version.
type CalVer struct{ Y, M, N int }

var calverRe = regexp.MustCompile(`^v?([0-9]{4})\.([0-9]{1,2})\.([0-9]{1,6})$`)

func ParseCalVer(s string) (CalVer, error) {
	m := calverRe.FindStringSubmatch(s)
	if m == nil {
		return CalVer{}, fmt.Errorf("%q is not a release version (want YYYY.M.N, e.g. 2026.11.1; prerelease suffixes are not versions)", s)
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	n, _ := strconv.Atoi(m[3])
	if mo < 1 || mo > 12 {
		return CalVer{}, fmt.Errorf("%q: month %d is not 1-12", s, mo)
	}
	return CalVer{y, mo, n}, nil
}

func (a CalVer) Compare(b CalVer) int {
	for _, p := range [][2]int{{a.Y, b.Y}, {a.M, b.M}, {a.N, b.N}} {
		if p[0] != p[1] {
			if p[0] < p[1] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func (a CalVer) String() string { return fmt.Sprintf("%d.%d.%d", a.Y, a.M, a.N) }

// Tag is "v" + the canonical version: the tag a release of that version carries.
func (a CalVer) Tag() string { return "v" + a.String() }

type apiRelease struct {
	Tag        string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

const apiLimit = 4 << 20

func (s Source) getAPI(ctx context.Context, path string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(s.API, "/")+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "bothy-update")
	resp, err := s.client().Do(req)
	if err != nil {
		if ctx.Err() == context.Canceled {
			return nil, err
		}
		return nil, &OfflineError{err}
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 200:
		return readCapped(resp.Body, apiLimit)
	case resp.StatusCode == 429 || (resp.StatusCode == 403 && (resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != "")):
		e := &RateLimitError{}
		if n, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && n > 0 {
			e.Reset = time.Unix(n, 0)
		}
		return nil, e
	case resp.StatusCode == 404:
		return nil, fmt.Errorf("GitHub has no such release or repository (%s)", path)
	}
	return nil, fmt.Errorf("GitHub answered %s for %s", resp.Status, path)
}

// Latest is the highest stable release: not a draft, not marked prerelease, and
// a tag that is a strict CalVer. "Highest version", not "most recently
// created": a patch release of an older line must not win over the newest line.
func (s Source) Latest(ctx context.Context) (CalVer, error) {
	b, err := s.getAPI(ctx, "/repos/"+AttestRepo+"/releases?per_page=30")
	if err != nil {
		return CalVer{}, err
	}
	var rs []apiRelease
	if err := json.Unmarshal(b, &rs); err != nil {
		return CalVer{}, fmt.Errorf("GitHub's release list is not the JSON this bothy understands: %w", err)
	}
	var best CalVer
	found := false
	for _, r := range rs {
		if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, "v") {
			continue
		}
		v, err := ParseCalVer(r.Tag)
		if err != nil || v.Tag() != r.Tag { // "v2026.11.01" is not the tag we would build a URL for
			continue
		}
		if !found || v.Compare(best) > 0 {
			best, found = v, true
		}
	}
	if !found {
		return CalVer{}, errors.New("GitHub lists no stable release of Bothy (drafts, prereleases and non-CalVer tags are ignored)")
	}
	return best, nil
}

// ByTag checks that a specific release exists and is a stable one.
func (s Source) ByTag(ctx context.Context, v CalVer) error {
	b, err := s.getAPI(ctx, "/repos/"+AttestRepo+"/releases/tags/"+v.Tag())
	if err != nil {
		return err
	}
	var r apiRelease
	if err := json.Unmarshal(b, &r); err != nil {
		return fmt.Errorf("GitHub's release record is not the JSON this bothy understands: %w", err)
	}
	if r.Tag != v.Tag() {
		return fmt.Errorf("asked GitHub for %s and it answered with release %q", v.Tag(), r.Tag)
	}
	if r.Draft || r.Prerelease {
		return fmt.Errorf("release %s is a draft or a prerelease: refusing it", v.Tag())
	}
	return nil
}

func (s Source) assetURL(v CalVer, name string) string {
	return strings.TrimRight(s.Download, "/") + "/" + v.Tag() + "/" + name
}

func (s Source) fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	r, err := s.open(ctx, url)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return readCapped(r, limit)
}

func (s Source) open(ctx context.Context, url string) (io.ReadCloser, error) {
	if !strings.HasPrefix(url, "https://") {
		return nil, fmt.Errorf("%s: only https is used for release downloads", url)
	}
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "bothy-update")
	resp, err := s.client().Do(req)
	if err != nil {
		if ctx.Err() == context.Canceled {
			return nil, err
		}
		return nil, &OfflineError{err}
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return resp.Body, nil
}

// archiveName is what scripts/build-cli.sh produces for a target.
func archiveName(v CalVer, goos, goarch string) string {
	ext := ".tar.gz"
	if goos == "windows" {
		ext = ".zip"
	}
	return "bothy_" + v.String() + "_" + goos + "_" + goarch + ext
}

// SelfOptions are the inputs of the binary update that Options does not carry.
// The function-valued fields exist so tests can inject failures; nil means the
// real thing.
type SelfOptions struct {
	Source  Source
	To      string // an exact release tag; "" = the latest stable
	Check   bool
	ExePath string // the running binary; "" = os.Executable, symlinks resolved
	// Apply runs the stack update with the NEW binary (the stack definition is
	// embedded in it). Default: exec `<exe> <ApplyArgs...>` with stdio inherited.
	Apply     func(ctx context.Context, exe string) error
	ApplyArgs []string
	// Smoke runs the downloaded binary's `version` before it replaces anything.
	Smoke  func(ctx context.Context, path string) (string, error)
	Rename func(oldpath, newpath string) error
}

const (
	archiveLimit = 200 << 20 // the archive
	binaryLimit  = 300 << 20 // the unpacked binary (a zip bomb stops here)
)

// SelfUpdate moves the binary to a newer release and then applies that
// release's stack with the new binary. It reports handled=false when the
// binary is already the target (or newer), so the caller falls through to
// Update, which re-applies this binary's own release as before.
func SelfUpdate(ctx context.Context, h Host, o Options, so SelfOptions, out io.Writer) (handled bool, err error) {
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	cur, err := ParseCalVer(o.BinaryVersion)
	if err != nil {
		return false, fmt.Errorf("this binary is %q: only a release build can move to a newer release (download a release binary)", o.BinaryVersion)
	}
	rec, err := readReceipt(o.receiptPath())
	if err != nil {
		return false, err
	}
	if rec == nil {
		return false, fmt.Errorf("nothing is installed here (no receipt at %s): run `bothy install`", o.receiptPath())
	}

	var target CalVer
	if so.To != "" {
		if target, err = ParseCalVer(so.To); err != nil {
			return false, err
		}
		if err := so.Source.ByTag(ctx, target); err != nil {
			return false, err
		}
	} else if target, err = so.Source.Latest(ctx); err != nil {
		return false, err
	}
	switch c := target.Compare(cur); {
	case c == 0:
		p("bothy %s is the release you asked for / the latest: the binary is up to date.", cur)
		return false, nil
	case c < 0 && so.To == "":
		p("bothy %s is newer than the latest stable release (%s): nothing to move to.", cur, target)
		return false, nil
	case c < 0 && !o.AllowDowngrade:
		return false, fmt.Errorf("%s is older than this binary (%s): refusing a downgrade (pass --allow-downgrade to force it)", target.Tag(), cur)
	}
	p("bothy update: binary %s -> %s", cur, target)
	if so.Check {
		p("%s is available. Nothing was downloaded or changed. `bothy update` would verify it exactly as install does, replace this binary (keeping bothy.prev), then update the stack with it.", target.Tag())
		return true, nil
	}
	if Packager != "" {
		return false, fmt.Errorf("this bothy was installed by %s: update it with that package manager, not with `bothy update` (a newer release, %s, exists)", Packager, target.Tag())
	}

	exe := so.ExePath
	if exe == "" {
		if exe, err = os.Executable(); err != nil {
			return false, err
		}
		if exe, err = filepath.EvalSymlinks(exe); err != nil {
			return false, err
		}
	}
	dir := filepath.Dir(exe)
	if f, err := os.CreateTemp(dir, ".bothy-write-test-*"); err != nil {
		return false, fmt.Errorf("cannot write next to the binary (%s): %w. Nothing was changed; install bothy somewhere you own, or update it the way you installed it", dir, err)
	} else {
		f.Close()
		os.Remove(f.Name())
	}

	// 1. metadata, verified by the path install uses.
	src := so.Source
	cb, err := src.fetch(ctx, src.assetURL(target, "checksums.txt"), 1<<20)
	if err != nil {
		return false, fmt.Errorf("fetch checksums.txt: %w", err)
	}
	mb, err := src.fetch(ctx, src.assetURL(target, "release-manifest.json"), 1<<20)
	if err != nil {
		return false, fmt.Errorf("fetch release manifest: %w", err)
	}
	// The manifest's version must equal the TAG (it is the target version here,
	// not the running binary's). The ldflags pin belongs to the running binary's
	// own release, so it does not apply to a different one.
	m, msha, err := VerifyManifest(mb, cb, target.String(), "")
	if err != nil {
		return false, err
	}
	p("manifest: release-manifest.json sha256 %s matches checksums.txt; version %s commit %s", msha[:12], m.Version, m.Commit[:12])
	if err := checkAttestation(ctx, h, src.assetURL(target, "checksums.txt"), cb, out, o.RequireAttestation); err != nil {
		return false, err
	}

	// 2. the archive, hashed while it downloads, then unpacked next to the binary.
	name := archiveName(target, h.GOOS(), h.GOARCH())
	want, err := ChecksumFor(cb, name)
	if err != nil {
		return false, err
	}
	tmpd, err := os.MkdirTemp("", "bothy-update-")
	if err != nil {
		return false, err
	}
	defer os.RemoveAll(tmpd)
	arc := filepath.Join(tmpd, name)
	p("-> download %s", name)
	if err := download(ctx, src, src.assetURL(target, name), arc, want); err != nil {
		return false, err
	}
	p("   sha256 matches checksums.txt")
	newBin := filepath.Join(dir, ".bothy-new-"+strconv.Itoa(os.Getpid()))
	defer os.Remove(newBin) // gone after a successful rename; cleanup otherwise
	if err := extractBinary(arc, newBin, h.GOOS()); err != nil {
		return false, err
	}
	smoke := so.Smoke
	if smoke == nil {
		smoke = runVersion
	}
	got, err := smoke(ctx, newBin)
	if err != nil || !strings.HasPrefix(got, "bothy "+target.String()+" ") {
		return false, fmt.Errorf("the downloaded binary does not report itself as %s (got %q, error %v): not installing it", target, strings.TrimSpace(firstLine(got)), err)
	}

	// 3. swap, keeping the old binary as bothy.prev.
	rename := so.Rename
	if rename == nil {
		rename = os.Rename
	}
	prev := exe + ".prev"
	if err := swapBinary(exe, newBin, prev, h.GOOS(), rename); err != nil {
		return false, err
	}
	p("   replaced %s (the previous binary is kept as %s)", exe, prev)

	// 4. the stack, with the new binary. Failing here puts the old binary back,
	// so `bothy update` either moves both or neither (the stack's own update
	// already rolled itself back).
	apply := so.Apply
	if apply == nil {
		apply = func(ctx context.Context, exe string) error {
			c := exec.CommandContext(ctx, exe, so.ApplyArgs...)
			c.Stdout, c.Stderr, c.Stdin = out, os.Stderr, os.Stdin
			return c.Run()
		}
	}
	p("-> update the stack with the new binary")
	if err := apply(ctx, exe); err != nil {
		if rerr := restoreBinary(exe, prev, h.GOOS(), rename); rerr != nil {
			return true, fmt.Errorf("the stack update failed (%v) and putting the old binary back failed too (%v): the previous binary is %s", err, rerr, prev)
		}
		return true, fmt.Errorf("the stack update to %s failed (the stack was rolled back by its own rollback); the old binary %s is back in place: %w", target, cur, err)
	}
	p("updated: bothy %s -> %s. The previous binary is %s (to go back: stop bothy, move it over %s).", cur, target, prev, exe)
	return true, nil
}

func download(ctx context.Context, s Source, url, dst, wantSHA string) error {
	r, err := s.open(ctx, url)
	if err != nil {
		return err
	}
	defer r.Close()
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, archiveLimit+1))
	if err != nil {
		return fmt.Errorf("download interrupted after %d bytes: %w", n, err)
	}
	if n > archiveLimit {
		return fmt.Errorf("the archive is larger than %d bytes: refusing it", archiveLimit)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		return fmt.Errorf("the downloaded archive does not match checksums.txt (got sha256 %s, checksums say %s): refusing to install", got, wantSHA)
	}
	return nil
}

// extractBinary unpacks the archive's ONE file, named bothy (bothy.exe on
// windows), to dst with mode 0755. Any other entry, or a path, is refused.
func extractBinary(arc, dst, goos string) error {
	want := "bothy"
	if goos == "windows" {
		want = "bothy.exe"
	}
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(dst)
		}
	}()
	var r io.Reader
	if goos == "windows" {
		z, err := zip.OpenReader(arc)
		if err != nil {
			return fmt.Errorf("the archive is not a zip: %w", err)
		}
		defer z.Close()
		if len(z.File) != 1 || z.File[0].Name != want || z.File[0].UncompressedSize64 > binaryLimit {
			return fmt.Errorf("the archive must hold exactly one file, %s", want)
		}
		rc, err := z.File[0].Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		r = rc
	} else {
		af, err := os.Open(arc)
		if err != nil {
			return err
		}
		defer af.Close()
		gz, err := gzip.NewReader(af)
		if err != nil {
			return fmt.Errorf("the archive is not a gzip file: %w", err)
		}
		tr := tar.NewReader(gz)
		hd, err := tr.Next()
		if err != nil || hd.Name != want || hd.Typeflag != tar.TypeReg || hd.Size > binaryLimit {
			return fmt.Errorf("the archive must hold exactly one regular file, %s", want)
		}
		r = tr
	}
	n, err := io.Copy(f, io.LimitReader(r, binaryLimit+1))
	if err != nil {
		return err
	}
	if n > binaryLimit || n == 0 {
		return fmt.Errorf("the unpacked binary has an implausible size (%d bytes)", n)
	}
	if goos != "windows" {
		if tr, ok := r.(*tar.Reader); ok {
			if _, err := tr.Next(); err != io.EOF {
				return fmt.Errorf("the archive must hold exactly one file, %s (it holds more)", want)
			}
		}
	}
	ok = true
	return f.Close()
}

func runVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, path, "version").Output()
	return string(b), err
}

func copyFile(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

// swapBinary puts newBin at exe and the old binary at prev.
//
// Unix: the old binary is COPIED to prev (through a temp name, then renamed),
// then newBin is renamed over exe. rename(2) replaces the directory entry
// atomically, and a running process keeps its inode, so there is no moment
// without a binary at exe and replacing a running executable is fine.
//
// Windows: a running .exe cannot be overwritten or deleted but CAN be renamed,
// so the order is rename exe -> prev, then rename newBin -> exe; if the second
// fails the first is undone. There is a window with no exe at that path; it is
// two renames wide. UNPROVEN on a real Windows host: the code path is tested on
// Linux with the Windows order forced, not on Windows.
func swapBinary(exe, newBin, prev, goos string, rename func(a, b string) error) error {
	if goos == "windows" {
		_ = os.Remove(prev) // an earlier .prev is not running; fails harmlessly if it is
		if err := rename(exe, prev); err != nil {
			return fmt.Errorf("cannot move the running binary aside (nothing was changed): %w", err)
		}
		if err := rename(newBin, exe); err != nil {
			if rerr := rename(prev, exe); rerr != nil {
				return fmt.Errorf("cannot install the new binary (%v) and cannot restore the old one (%v): it is %s", err, rerr, prev)
			}
			return fmt.Errorf("cannot install the new binary (the old one is back): %w", err)
		}
		return nil
	}
	tmpPrev := prev + ".tmp"
	if err := copyFile(exe, tmpPrev, 0o755); err != nil {
		return fmt.Errorf("cannot keep the old binary as %s (nothing was changed): %w", prev, err)
	}
	if err := rename(tmpPrev, prev); err != nil {
		os.Remove(tmpPrev)
		return fmt.Errorf("cannot keep the old binary as %s (nothing was changed): %w", prev, err)
	}
	if err := rename(newBin, exe); err != nil {
		return fmt.Errorf("cannot replace the binary (the old one is untouched): %w", err)
	}
	return nil
}

// restoreBinary undoes swapBinary after a later failure.
func restoreBinary(exe, prev, goos string, rename func(a, b string) error) error {
	if goos == "windows" {
		_ = os.Remove(exe) // the new binary is not running any more
	}
	return rename(prev, exe)
}
