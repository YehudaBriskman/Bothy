package install

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const commit2 = "fedcba9876543210fedcba9876543210fedcba98"

// release writes a manifest+checksums for version whose three images carry the
// digests a, b, c (web, traefik, files) and commit cm.
func release(t *testing.T, version, cm string, a, b, c byte) (mp, cp string) {
	t.Helper()
	dir := t.TempDir()
	mb := []byte(fmt.Sprintf(`{"schema":1,"version":%q,"commit":%q,
 "images":{"bothy-web":{"ref":"ghcr.io/o/bothy-web@%s","platforms":["linux/amd64"]},
           "bothy-files":{"ref":"ghcr.io/o/bothy-files@%s","platforms":["linux/amd64"]}},
 "third_party":{"traefik":{"ref":"traefik@%s"}},
 "assets":{"cli":"checksums.txt"}}`, version, cm, digest(a), digest(c), digest(b)))
	s := sha256.Sum256(mb)
	mp, cp = filepath.Join(dir, "release-manifest.json"), filepath.Join(dir, "checksums.txt")
	_ = os.WriteFile(mp, mb, 0o644)
	_ = os.WriteFile(cp, []byte(hex.EncodeToString(s[:])+"  release-manifest.json\n"), 0o644)
	return
}

type box struct {
	t    *testing.T
	h    *fakeHost
	o    Options
	st   *Stack
	web  []byte
	rev  string // what /version.json answers
	good map[string]bool
}

func (b *box) ca(more ...string) string {
	return "docker " + strings.Join(b.o.composeArgs(b.st, more...), " ")
}

var upArgs = []string{"up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", "--remove-orphans"}

func (b *box) registerImages(a, tr, f byte, pullOK bool) {
	for _, ref := range []string{"ghcr.io/o/bothy-web@" + digest(a), "traefik@" + digest(tr), "ghcr.io/o/bothy-files@" + digest(f)} {
		if pullOK {
			b.h.cmds["docker pull --quiet "+ref] = ref
			b.h.cmds["docker image inspect --format {{json .RepoDigests}} "+ref] = `["` + ref + `"]`
		} else {
			b.h.cmds["docker pull --quiet "+ref] = "!manifest unknown"
		}
		b.h.cmds["docker image inspect --format {{.Id}} "+ref] = "!no such image"
	}
}

func (b *box) have(refs ...string) {
	for _, r := range refs {
		b.h.cmds["docker image inspect --format {{.Id}} "+r] = "sha256:id"
	}
}

// newBox installs release 2026.11.0 (digests a b c) on fakes.
func newBox(t *testing.T) *box {
	o := opts(t)
	o.DryRun = false
	b := &box{t: t, h: newHost(), o: o, st: mini(t), web: []byte("<html>portal 1</html>"), rev: commit}
	o.HTTPGet = func(u string) (int, []byte, error) {
		if strings.HasSuffix(u, "/version.json") {
			return 200, []byte(`{"revision":"` + b.rev + `"}`), nil
		}
		return 200, b.web, nil
	}
	b.o = o
	b.registerImages('a', 'b', 'c', true)
	b.h.cmds[b.ca(upArgs...)] = ""
	b.h.cmds[b.ca("exec", "-T", "bothy-web", "cat", "/usr/share/nginx/html/index.html")] = string(b.web)
	b.h.cmds[b.ca("ps", "--format", "json")] = `{"Service":"bothy-web","State":"running","Health":"healthy"}
{"Service":"traefik","State":"running","Health":"healthy"}
{"Service":"bothy-files","State":"running","Health":"healthy"}
`
	var out bytes.Buffer
	if err := Install(context.Background(), b.h, b.o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	b.have("ghcr.io/o/bothy-web@"+digest('a'), "traefik@"+digest('b'), "ghcr.io/o/bothy-files@"+digest('c'))
	return b
}

func (b *box) toRelease(version, cm string, a, tr, f byte, pullOK bool) {
	mp, cp := release(b.t, version, cm, a, tr, f)
	b.o.ManifestSrc, b.o.ChecksumsSrc, b.o.BinaryVersion = mp, cp, version
	b.registerImages(a, tr, f, pullOK)
}

func (b *box) readFile(rel string) string {
	bb, err := os.ReadFile(filepath.Join(b.o.stackDir(), rel))
	if err != nil {
		b.t.Fatal(err)
	}
	return string(bb)
}

func TestUpdateCheckChangesNothing(t *testing.T) {
	b := newBox(t)
	b.toRelease("2026.11.1", commit2, 'd', 'e', 'f', true)
	before := b.readFile(".env")
	b.h.ran = nil
	var out bytes.Buffer
	if err := Update(context.Background(), b.h, b.o, true, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	s := out.String()
	for _, want := range []string{"2026.11.0", "2026.11.1", "BOTHY_IMAGE_BOTHY_WEB", "-> ", "Nothing was changed", "attestation: SKIPPED"} {
		if !strings.Contains(s, want) {
			t.Errorf("--check output lacks %q:\n%s", want, s)
		}
	}
	for _, r := range b.h.ran {
		if strings.Contains(r, " pull ") || strings.Contains(r, " up ") || strings.Contains(r, " down ") {
			t.Errorf("--check ran %q", r)
		}
	}
	if b.readFile(".env") != before {
		t.Error("--check rewrote .env")
	}
	if _, err := os.Stat(filepath.Join(b.o.DataDir, "previous")); err == nil {
		t.Error("--check made a rollback point")
	}
}

func TestUpdateSucceedsAndRecordsPrevious(t *testing.T) {
	b := newBox(t)
	oldEnv := b.readFile(".env")
	b.toRelease("2026.11.1", commit2, 'd', 'e', 'f', true)
	b.rev, b.web = commit2, []byte("<html>portal 2</html>")
	b.h.cmds[b.ca("exec", "-T", "bothy-web", "cat", "/usr/share/nginx/html/index.html")] = string(b.web)
	var out bytes.Buffer
	if err := Update(context.Background(), b.h, b.o, false, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	r, _ := readReceipt(b.o.receiptPath())
	if r.Status != "complete" || r.Version != "2026.11.1" || r.Commit != commit2 || r.Previous == nil || r.Previous.Version != "2026.11.0" ||
		r.Previous.Images["BOTHY_IMAGE_TRAEFIK"] != "traefik@"+digest('b') || r.Images["BOTHY_IMAGE_TRAEFIK"] != "traefik@"+digest('e') {
		t.Fatalf("receipt: %+v", r)
	}
	if !strings.Contains(out.String(), "updated: release 2026.11.0 -> 2026.11.1") {
		t.Errorf("no success line:\n%s", out.String())
	}
	if prev, err := os.ReadFile(filepath.Join(b.o.DataDir, "previous", "stack", ".env")); err != nil || string(prev) != oldEnv {
		t.Errorf("the rollback point does not hold the old .env: %v", err)
	}
	if b.readFile(".env") == oldEnv || !strings.Contains(b.readFile(".env"), digest('e')) {
		t.Error(".env was not rewritten with the new digests")
	}
	// downgrade (binary of the older release against the newer receipt) is refused
	mp, cp := release(t, "2026.11.0", commit, 'a', 'b', 'c')
	b.o.ManifestSrc, b.o.ChecksumsSrc, b.o.BinaryVersion = mp, cp, "2026.11.0"
	if err := Update(context.Background(), b.h, b.o, false, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "downgrade") {
		t.Fatalf("downgrade: %v", err)
	}
}

// Forced failures: each must end with the PREVIOUS release's files, digests and
// bytes, a complete receipt that says why, and no new image left running.
func TestUpdateRollsBackOnFailure(t *testing.T) {
	cases := map[string]func(b *box){
		"a digest the registry does not have": func(b *box) {
			b.toRelease("2026.11.1", commit2, 'd', 'e', 'f', false)
		},
		"a container that never becomes healthy": func(b *box) {
			b.toRelease("2026.11.1", commit2, 'd', 'e', 'f', true)
			// the first `up` (the new release) fails; after the rollback restores
			// the old .env the very same command line works again, which the
			// fake models by counting
			b.h.upFailures = 1
		},
		"bytes that do not match": func(b *box) {
			b.toRelease("2026.11.1", commit2, 'd', 'e', 'f', true)
			b.rev = commit // the new release still answers with the old revision
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			b := newBox(t)
			oldEnv, oldCompose := b.readFile(".env"), b.readFile("compose.yml")
			oldRec, _ := readReceipt(b.o.receiptPath())
			setup(b)
			b.h.upCmd = b.ca(upArgs...)
			b.h.ran = nil
			var out bytes.Buffer
			err := Update(context.Background(), b.h, b.o, false, &out)
			if err == nil || !strings.Contains(err.Error(), "rolled back") {
				t.Fatalf("want a rolled-back failure, got %v\n%s", err, out.String())
			}
			if b.readFile(".env") != oldEnv || b.readFile("compose.yml") != oldCompose {
				t.Error("the previous files were not restored byte for byte")
			}
			r, _ := readReceipt(b.o.receiptPath())
			if r.Status != "complete" || r.Version != "2026.11.0" || r.Commit != oldRec.Commit || r.LastUpdateError == "" {
				t.Fatalf("receipt after rollback: %+v", r)
			}
			for v, ref := range oldRec.Images {
				if r.Images[v] != ref {
					t.Errorf("receipt image %s = %s, want the previous %s", v, r.Images[v], ref)
				}
			}
			s := out.String()
			if !strings.Contains(s, "rolling back to 2026.11.0") || !strings.Contains(s, "rolled back: release 2026.11.0 is running and verified by bytes") {
				t.Errorf("rollback not reported:\n%s", s)
			}
		})
	}
}

func TestUpdateRefusals(t *testing.T) {
	o := opts(t)
	o.DryRun = false
	if err := Update(context.Background(), newHost(), o, false, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "nothing is installed") {
		t.Fatalf("no receipt: %v", err)
	}
	b := newBox(t)
	r, _ := readReceipt(b.o.receiptPath())
	r.Status = "in-progress"
	_ = writeReceipt(b.o.receiptPath(), r)
	if err := Update(context.Background(), b.h, b.o, false, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "did not finish") {
		t.Fatalf("incomplete install: %v", err)
	}
	// a manifest that does not match its checksum line
	b = newBox(t)
	mp, cp := release(t, "2026.11.1", commit2, 'd', 'e', 'f')
	_ = os.WriteFile(mp, append([]byte(" "), mustRead(t, mp)...), 0o644)
	b.o.ManifestSrc, b.o.ChecksumsSrc, b.o.BinaryVersion = mp, cp, "2026.11.1"
	if err := Update(context.Background(), b.h, b.o, false, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "does not match checksums.txt") {
		t.Fatalf("tampered manifest: %v", err)
	}
}

func mustRead(t *testing.T, p string) []byte {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// gh present and rejecting is fatal; gh absent prints the exact command and
// says skipped; a local source is skipped with its own reason.
func TestAttestation(t *testing.T) {
	cb := []byte("x  release-manifest.json\n")
	h := newHost()
	var out bytes.Buffer
	if err := checkAttestation(context.Background(), h, "/tmp/checksums.txt", cb, &out); err != nil || !strings.Contains(out.String(), "SKIPPED") || !strings.Contains(out.String(), "local file") {
		t.Fatalf("local: %v %s", err, out.String())
	}
	out.Reset()
	h.cmds["gh --version"] = "!not found"
	if err := checkAttestation(context.Background(), h, "https://example.test/checksums.txt", cb, &out); err != nil ||
		!strings.Contains(out.String(), "SKIPPED") || !strings.Contains(out.String(), "gh attestation verify checksums.txt --repo "+AttestRepo) {
		t.Fatalf("no gh: %v %s", err, out.String())
	}
	h.cmds["gh --version"] = "gh version 2.50"
	h.ghVerify = "!no matching attestation"
	if err := checkAttestation(context.Background(), h, "https://example.test/checksums.txt", cb, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("gh rejecting must fail: %v", err)
	}
	h.ghVerify = "ok"
	out.Reset()
	if err := checkAttestation(context.Background(), h, "https://example.test/checksums.txt", cb, &out); err != nil || !strings.Contains(out.String(), "verified by gh") {
		t.Fatalf("gh ok: %v %s", err, out.String())
	}
}
