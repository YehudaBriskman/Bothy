package install

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCalVer(t *testing.T) {
	for _, s := range []string{"2026.11.1", "v2026.1.10", "2027.12.0"} {
		if _, err := ParseCalVer(s); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	for _, s := range []string{"", "dev", "2026.13.0", "2026.0.1", "2026.11", "2026.11.1-rc1", "2026.11.1+x", "26.11.1", "v2026.11.1.2", "2026.11.-1"} {
		if _, err := ParseCalVer(s); err == nil {
			t.Errorf("%q must not parse", s)
		}
	}
	cmp := func(a, b string) int { x, _ := ParseCalVer(a); y, _ := ParseCalVer(b); return x.Compare(y) }
	if cmp("2026.11.1", "2026.11.0") != 1 || cmp("2026.12.0", "2026.11.9") != 1 || cmp("2027.1.0", "2026.12.9") != 1 ||
		cmp("2026.11.9", "2026.11.10") != -1 || cmp("v2026.11.1", "2026.11.1") != 0 {
		t.Error("CalVer ordering is wrong (numeric, not lexical)")
	}
}

// relSrv is a fake GitHub: the releases API plus the download area, over TLS.
type relSrv struct {
	t        *testing.T
	ts       *httptest.Server
	releases []map[string]any
	files    map[string][]byte // "/dl/v2026.12.0/name" -> bytes
	apiCode  int               // non-zero: every API call answers this
	apiHdr   map[string]string
	apiBody  string // non-empty: replaces the list body
	cut      string // a path whose body is cut short (Content-Length lies)
	hits     []string
}

func newRelSrv(t *testing.T) *relSrv {
	r := &relSrv{t: t, files: map[string][]byte{}}
	r.ts = httptest.NewTLSServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.ts.Close)
	return r
}

func (r *relSrv) source() Source {
	return Source{API: r.ts.URL, Download: r.ts.URL + "/dl", HTTP: r.ts.Client()}
}

func (r *relSrv) serve(w http.ResponseWriter, q *http.Request) {
	r.hits = append(r.hits, q.URL.Path)
	if strings.HasPrefix(q.URL.Path, "/repos/") {
		for k, v := range r.apiHdr {
			w.Header().Set(k, v)
		}
		if r.apiCode != 0 {
			w.WriteHeader(r.apiCode)
			return
		}
		if tag, ok := strings.CutPrefix(q.URL.Path, "/repos/"+AttestRepo+"/releases/tags/"); ok {
			for _, rel := range r.releases {
				if rel["tag_name"] == tag {
					fmt.Fprint(w, jsonOf(rel))
					return
				}
			}
			http.NotFound(w, q)
			return
		}
		if r.apiBody != "" {
			fmt.Fprint(w, r.apiBody)
			return
		}
		fmt.Fprint(w, jsonOf(r.releases))
		return
	}
	b, ok := r.files[q.URL.Path]
	if !ok {
		http.NotFound(w, q)
		return
	}
	if q.URL.Path == r.cut {
		w.Header().Set("Content-Length", fmt.Sprint(len(b)))
		w.Write(b[:len(b)/2])
		return // the handler returns with half the promised body: the connection is cut
	}
	w.Write(b)
}

func jsonOf(v any) string {
	var buf bytes.Buffer
	switch x := v.(type) {
	case map[string]any:
		buf.WriteString(`{`)
		first := true
		for k, e := range x {
			if !first {
				buf.WriteString(",")
			}
			first = false
			fmt.Fprintf(&buf, "%q:%v", k, lit(e))
		}
		buf.WriteString(`}`)
	case []map[string]any:
		buf.WriteString("[")
		for i, e := range x {
			if i > 0 {
				buf.WriteString(",")
			}
			buf.WriteString(jsonOf(e))
		}
		buf.WriteString("]")
	}
	return buf.String()
}

func lit(e any) string {
	if s, ok := e.(string); ok {
		return fmt.Sprintf("%q", s)
	}
	return fmt.Sprint(e)
}

func tgz(t *testing.T, entries map[string]string) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, n := range sortedKeys(entries) {
		_ = tw.WriteHeader(&tar.Header{Name: n, Mode: 0o755, Size: int64(len(entries[n])), Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte(entries[n]))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func fakeBin(version string) string {
	return "#!/bin/sh\necho 'bothy " + version + " (speaks api 1)'\n"
}

type relOpt struct {
	prerelease, draft bool
	manifestVersion   string // "" = the tag's version
	tamper            bool   // the archive differs from what checksums.txt lists
	badManifestSum    bool
	archive           map[string]string // nil = the one good file
}

// publish adds release v (e.g. "2026.12.0") with a linux/amd64 archive.
func (r *relSrv) publish(v string, o relOpt) {
	t := r.t
	tag := "v" + v
	r.releases = append(r.releases, map[string]any{"tag_name": tag, "draft": o.draft, "prerelease": o.prerelease})
	entries := o.archive
	if entries == nil {
		entries = map[string]string{"bothy": fakeBin(v)}
	}
	arc := tgz(t, entries)
	name := "bothy_" + v + "_linux_amd64.tar.gz"
	asum := sha256.Sum256(arc)
	if o.tamper {
		arc = append(append([]byte{}, arc...), 0)
	}
	mv := o.manifestVersion
	if mv == "" {
		mv = v
	}
	mb := []byte(fmt.Sprintf(`{"schema":1,"version":%q,"commit":%q,"images":{"bothy-web":{"ref":"ghcr.io/o/bothy-web@%s"}},"third_party":{},"assets":{}}`, mv, commit2, digest('d')))
	msum := sha256.Sum256(mb)
	msumHex := hex.EncodeToString(msum[:])
	if o.badManifestSum {
		msumHex = strings.Repeat("0", 64)
	}
	cb := fmt.Sprintf("%s  %s\n%s  release-manifest.json\n", hex.EncodeToString(asum[:]), name, msumHex)
	r.files["/dl/"+tag+"/"+name] = arc
	r.files["/dl/"+tag+"/release-manifest.json"] = mb
	r.files["/dl/"+tag+"/checksums.txt"] = []byte(cb)
}

func (r *relSrv) downloaded() bool {
	for _, h := range r.hits {
		if strings.HasPrefix(h, "/dl/") {
			return true
		}
	}
	return false
}

// selfBox is an installed box (receipt, 2026.11.0) plus a binary on disk.
type selfBox struct {
	*box
	exe     string
	rs      *relSrv
	so      SelfOptions
	applied []string
}

func newSelfBox(t *testing.T) *selfBox {
	b := newBox(t)
	b.o.BinaryVersion = "2026.11.0"
	rs := newRelSrv(t)
	exe := filepath.Join(t.TempDir(), "bothy")
	if err := os.WriteFile(exe, []byte(fakeBin("2026.11.0")), 0o755); err != nil {
		t.Fatal(err)
	}
	sb := &selfBox{box: b, exe: exe, rs: rs}
	sb.so = SelfOptions{Source: rs.source(), ExePath: exe, ApplyArgs: []string{"update", "--this-release"},
		Smoke: func(_ context.Context, path string) (string, error) { // never run a downloaded script in a unit test
			bb, err := os.ReadFile(path)
			if err != nil {
				return "", err
			}
			f := strings.Fields(string(bb))
			return "bothy " + f[3] + " ", nil
		},
		Apply: func(_ context.Context, exe string) error {
			bb, _ := os.ReadFile(exe)
			sb.applied = append(sb.applied, string(bb))
			return nil
		}}
	return sb
}

func (s *selfBox) run() (bool, string, error) {
	var out bytes.Buffer
	handled, err := SelfUpdate(context.Background(), s.h, s.o, s.so, &out)
	return handled, out.String(), err
}

func (s *selfBox) exeIs(v string) {
	s.t.Helper()
	b, err := os.ReadFile(s.exe)
	if err != nil || string(b) != fakeBin(v) {
		s.t.Fatalf("the binary is not %s: %q %v", v, b, err)
	}
}

func (s *selfBox) noLeftovers() {
	s.t.Helper()
	es, _ := os.ReadDir(filepath.Dir(s.exe))
	for _, e := range es {
		if e.Name() != "bothy" && e.Name() != "bothy.prev" {
			s.t.Errorf("stray file next to the binary: %s", e.Name())
		}
	}
}

func TestSelfUpdateNewer(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.11.0", relOpt{})
	s.rs.publish("2026.12.0", relOpt{})
	handled, out, err := s.run()
	if err != nil || !handled {
		t.Fatalf("%v handled=%v\n%s", err, handled, out)
	}
	s.exeIs("2026.12.0")
	if b, _ := os.ReadFile(s.exe + ".prev"); string(b) != fakeBin("2026.11.0") {
		t.Errorf("bothy.prev is not the old binary: %q", b)
	}
	if len(s.applied) != 1 || s.applied[0] != fakeBin("2026.12.0") {
		t.Errorf("the stack update must run AFTER the swap, with the new binary in place: %q", s.applied)
	}
	for _, w := range []string{"2026.11.0 -> 2026.12.0", "matches checksums.txt", "attestation: SKIPPED", "sha256 matches", "bothy.prev"} {
		if !strings.Contains(out, w) {
			t.Errorf("output lacks %q:\n%s", w, out)
		}
	}
	if fi, _ := os.Stat(s.exe); fi.Mode().Perm()&0o111 == 0 {
		t.Error("the new binary is not executable")
	}
	s.noLeftovers()
}

func TestSelfUpdateCheckChangesAndDownloadsNothing(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.so.Check = true
	handled, out, err := s.run()
	if err != nil || !handled || !strings.Contains(out, "2026.12.0 is available") {
		t.Fatalf("%v %v\n%s", err, handled, out)
	}
	s.exeIs("2026.11.0")
	if s.rs.downloaded() || len(s.applied) != 0 {
		t.Error("--check downloaded or applied something")
	}
}

func TestSelfUpdateSameAndOlderFallThrough(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.11.0", relOpt{})
	if handled, out, err := s.run(); err != nil || handled || !strings.Contains(out, "up to date") {
		t.Fatalf("same: %v %v\n%s", err, handled, out)
	}
	s.rs.publish("2026.10.3", relOpt{})
	s.o.BinaryVersion = "2026.11.5" // newer than anything released
	if handled, out, err := s.run(); err != nil || handled || !strings.Contains(out, "newer than the latest") {
		t.Fatalf("newer binary: %v %v\n%s", err, handled, out)
	}
	if s.rs.downloaded() {
		t.Error("downloaded for a non-update")
	}
}

func TestSelfUpdateToOlderNeedsAllowDowngrade(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.10.3", relOpt{})
	s.so.To = "v2026.10.3"
	if _, _, err := s.run(); err == nil || !strings.Contains(err.Error(), "refusing a downgrade") {
		t.Fatalf("want a downgrade refusal: %v", err)
	}
	s.exeIs("2026.11.0")
	s.o.AllowDowngrade = true
	if handled, out, err := s.run(); err != nil || !handled {
		t.Fatalf("%v\n%s", err, out)
	}
	s.exeIs("2026.10.3")
}

func TestSelfUpdateToExactTag(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.11.4", relOpt{})
	s.rs.publish("2026.12.0", relOpt{})
	s.so.To = "2026.11.4"
	if _, out, err := s.run(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	s.exeIs("2026.11.4")
	s.so.To = "v2026.99.0"
	if _, _, err := s.run(); err == nil {
		t.Error("an unparsable tag was accepted")
	}
}

func TestLatestIgnoresDraftsPrereleasesAndJunkAndPicksHighest(t *testing.T) {
	r := newRelSrv(t)
	r.publish("2026.12.0", relOpt{})
	r.publish("2027.1.0", relOpt{prerelease: true})
	r.publish("2027.2.0", relOpt{draft: true})
	r.publish("2026.9.14", relOpt{}) // created later, lower version
	r.releases = append(r.releases,
		map[string]any{"tag_name": "nightly", "draft": false, "prerelease": false},
		map[string]any{"tag_name": "v2026.13.0", "draft": false, "prerelease": false},
		map[string]any{"tag_name": "v2030.1.0-rc1", "draft": false, "prerelease": false},
		map[string]any{"tag_name": "v2030.01.0", "draft": false, "prerelease": false})
	v, err := r.source().Latest(context.Background())
	if err != nil || v.String() != "2026.12.0" {
		t.Fatalf("latest = %v, %v", v, err)
	}
	if err := r.source().ByTag(context.Background(), CalVer{2027, 1, 0}); err == nil || !strings.Contains(err.Error(), "prerelease") {
		t.Errorf("--to a prerelease must be refused: %v", err)
	}
}

func TestSelfUpdateAPIFailures(t *testing.T) {
	s := newSelfBox(t)
	cases := []struct {
		name string
		set  func()
		want string
	}{
		{"rate limited", func() {
			s.rs.apiCode, s.rs.apiHdr = 403, map[string]string{"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1893456000"}
		}, "rate-limited"},
		{"429", func() { s.rs.apiCode, s.rs.apiHdr = 429, nil }, "rate-limited"},
		{"server error", func() { s.rs.apiCode, s.rs.apiHdr = 502, nil }, "502"},
		{"malformed json", func() { s.rs.apiCode, s.rs.apiBody = 0, "{not json" }, "not the JSON"},
		{"no stable release", func() { s.rs.apiBody, s.rs.releases = "[]", nil }, "no stable release"},
	}
	for _, c := range cases {
		c.set()
		_, _, err := s.run()
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
		s.exeIs("2026.11.0")
		s.rs.apiCode, s.rs.apiBody, s.rs.apiHdr = 0, "", nil
	}
	var rl *RateLimitError
	s.rs.apiCode, s.rs.apiHdr = 403, map[string]string{"X-RateLimit-Remaining": "0"}
	if _, _, err := s.run(); !errors.As(err, &rl) {
		t.Errorf("want *RateLimitError: %v", err)
	}
	// a plain 403 (not a limit) is an error, not a rate limit
	s.rs.apiHdr = nil
	if _, _, err := s.run(); errors.As(err, &rl) {
		t.Errorf("a 403 without a limit header is not a rate limit: %v", err)
	}
	// offline: the server is gone
	s.rs.ts.Close()
	var off *OfflineError
	if _, _, err := s.run(); !errors.As(err, &off) || !strings.Contains(err.Error(), "--this-release") {
		t.Errorf("want an OfflineError that names the offline way out: %v", err)
	}
	s.exeIs("2026.11.0")
}

func TestSelfUpdateRefusals(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.o.BinaryVersion = "dev"
	if _, _, err := s.run(); err == nil || !strings.Contains(err.Error(), "release build") {
		t.Errorf("dev: %v", err)
	}
	s.o.BinaryVersion = "2026.11.0"
	if err := os.Remove(s.o.receiptPath()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.run(); err == nil || !strings.Contains(err.Error(), "nothing is installed") {
		t.Errorf("no receipt: %v", err)
	}
}

func TestSelfUpdatePackagerOwnsTheBinary(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	Packager = "deb"
	defer func() { Packager = "" }()
	if _, _, err := s.run(); err == nil || !strings.Contains(err.Error(), "deb") || s.rs.downloaded() {
		t.Fatalf("%v", err)
	}
	s.so.Check = true
	if handled, out, err := s.run(); err != nil || !handled || !strings.Contains(out, "available") {
		t.Fatalf("--check still reports: %v\n%s", err, out)
	}
}

func TestSelfUpdateRefusesBadReleases(t *testing.T) {
	cases := []struct {
		name string
		o    relOpt
		want string
	}{
		{"manifest version differs from the tag", relOpt{manifestVersion: "2026.11.9"}, "manifest is for version"},
		{"manifest does not match checksums.txt", relOpt{badManifestSum: true}, "does not match checksums.txt"},
		{"tampered archive", relOpt{tamper: true}, "does not match checksums.txt"},
		{"archive with an extra file", relOpt{archive: map[string]string{"bothy": fakeBin("2026.12.0"), "evil": "x"}}, "exactly one"},
		{"archive with a path", relOpt{archive: map[string]string{"../bothy": fakeBin("2026.12.0")}}, "exactly one"},
		{"binary that is another version", relOpt{archive: map[string]string{"bothy": fakeBin("2026.11.0")}}, "does not report itself"},
	}
	for _, c := range cases {
		s := newSelfBox(t)
		s.rs.publish("2026.12.0", c.o)
		_, _, err := s.run()
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", c.name, err)
		}
		s.exeIs("2026.11.0")
		if _, e := os.Stat(s.exe + ".prev"); e == nil {
			t.Errorf("%s: a refused release must not leave bothy.prev", c.name)
		}
		if len(s.applied) != 0 {
			t.Errorf("%s: the stack was updated", c.name)
		}
		s.noLeftovers()
	}
}

func TestSelfUpdateMissingArchiveForThisPlatform(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.h.arch = "riscv64"
	if _, _, err := s.run(); err == nil || !strings.Contains(err.Error(), "no line for bothy_2026.12.0_linux_riscv64") {
		t.Fatalf("%v", err)
	}
}

func TestSelfUpdateAttestationVerdictRefuses(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.h.cmds["gh --version"] = "gh version 2.50"
	s.h.ghVerify, s.h.ghCode = "!Error: no attestations found", 1
	if _, _, err := s.run(); err == nil || !strings.Contains(err.Error(), "NOT attested") {
		t.Fatalf("%v", err)
	}
	s.exeIs("2026.11.0")
	for _, h := range s.rs.hits {
		if strings.HasSuffix(h, ".tar.gz") {
			t.Error("the archive was downloaded although the attestation was refused")
		}
	}
	// --require-attestation turns a skip into a refusal as well
	s2 := newSelfBox(t)
	s2.rs.publish("2026.12.0", relOpt{})
	s2.o.RequireAttestation = true
	if _, _, err := s2.run(); err == nil || !strings.Contains(err.Error(), "--require-attestation") {
		t.Fatalf("%v", err)
	}
}

func TestSelfUpdateInterruptedDownload(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.rs.cut = "/dl/v2026.12.0/bothy_2026.12.0_linux_amd64.tar.gz"
	_, _, err := s.run()
	if err == nil || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("%v", err)
	}
	s.exeIs("2026.11.0")
	s.noLeftovers()
	// and a retry once the network is back succeeds
	s.rs.cut = ""
	if _, out, err := s.run(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	s.exeIs("2026.12.0")
}

func TestSelfUpdateRenameFailureLeavesTheOldBinary(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.so.Rename = func(a, b string) error {
		if b == s.exe {
			return errors.New("injected: text file busy")
		}
		return os.Rename(a, b)
	}
	_, _, err := s.run()
	if err == nil || !strings.Contains(err.Error(), "old one is untouched") {
		t.Fatalf("%v", err)
	}
	s.exeIs("2026.11.0")
	if len(s.applied) != 0 {
		t.Error("the stack was updated although the binary was not replaced")
	}
	if _, e := os.Stat(s.exe + ".prev.tmp"); e == nil {
		t.Error("temp prev left behind")
	}
}

func TestSwapWindowsOrderAndItsRollback(t *testing.T) {
	d := t.TempDir()
	exe, nb, prev := filepath.Join(d, "bothy.exe"), filepath.Join(d, "new"), filepath.Join(d, "bothy.exe.prev")
	_ = os.WriteFile(exe, []byte("old"), 0o755)
	_ = os.WriteFile(nb, []byte("new"), 0o755)
	var order []string
	rec := func(a, b string) error {
		order = append(order, filepath.Base(a)+">"+filepath.Base(b))
		return os.Rename(a, b)
	}
	if err := swapBinary(exe, nb, prev, "windows", rec); err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "bothy.exe>bothy.exe.prev,new>bothy.exe" {
		t.Errorf("the windows order is exe->prev first, then new->exe: %v", order)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new" {
		t.Error("new not in place")
	}
	// second rename fails: the old binary comes back
	_ = os.WriteFile(nb, []byte("newer"), 0o755)
	fail := func(a, b string) error {
		if b == exe && a == nb {
			return errors.New("injected")
		}
		return os.Rename(a, b)
	}
	if err := swapBinary(exe, nb, prev, "windows", fail); err == nil || !strings.Contains(err.Error(), "old one is back") {
		t.Fatalf("%v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new" {
		t.Errorf("rollback lost the binary: %q", b)
	}
}

func TestSelfUpdateStackFailurePutsTheOldBinaryBack(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.so.Apply = func(_ context.Context, exe string) error {
		s.exeIs("2026.12.0") // it ran against the new binary
		return errors.New("update to 2026.12.0 failed at up and was rolled back")
	}
	handled, _, err := s.run()
	if err == nil || !handled || !strings.Contains(err.Error(), "old binary 2026.11.0 is back") {
		t.Fatalf("%v handled=%v", err, handled)
	}
	s.exeIs("2026.11.0")
	s.noLeftovers()
}

func TestSelfUpdateTwiceKeepsOnlyTheLatestPrev(t *testing.T) {
	s := newSelfBox(t)
	s.rs.publish("2026.12.0", relOpt{})
	s.rs.publish("2027.1.0", relOpt{})
	s.so.To = "2026.12.0"
	if _, out, err := s.run(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	s.o.BinaryVersion, s.so.To = "2026.12.0", ""
	if _, out, err := s.run(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	s.exeIs("2027.1.0")
	if b, _ := os.ReadFile(s.exe + ".prev"); string(b) != fakeBin("2026.12.0") {
		t.Errorf("bothy.prev should be the immediately previous binary: %q", b)
	}
}

func TestExtractZip(t *testing.T) {
	d := t.TempDir()
	arc := filepath.Join(d, "a.zip")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("bothy.exe")
	_, _ = w.Write([]byte("MZ-binary"))
	zw.Close()
	_ = os.WriteFile(arc, buf.Bytes(), 0o600)
	dst := filepath.Join(d, "out")
	if err := extractBinary(arc, dst, "windows"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "MZ-binary" {
		t.Errorf("%q", b)
	}
	if err := extractBinary(arc, filepath.Join(d, "x"), "linux"); err == nil {
		t.Error("a zip is not a tar.gz")
	}
}

// The one test that really runs a downloaded file: the smoke step.
func TestRunVersionSmoke(t *testing.T) {
	if _, err := os.Stat("/bin/sh"); err != nil {
		t.Skip("no /bin/sh")
	}
	p := filepath.Join(t.TempDir(), "bothy")
	_ = os.WriteFile(p, []byte(fakeBin("2026.12.0")), 0o755)
	got, err := runVersion(context.Background(), p)
	if err != nil || !strings.HasPrefix(got, "bothy 2026.12.0 ") {
		t.Fatalf("%q %v", got, err)
	}
}
