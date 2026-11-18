package install

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/YehudaBriskman/Bothy/cli/internal/stackgen"
)

// ---- the drift check -------------------------------------------------------

// The embedded stack must equal what stack/modes.yml and the repo's compose
// files generate right now. When it fails: `go generate ./...` in cli/.
func TestEmbeddedStackIsCurrent(t *testing.T) {
	want, err := stackgen.Generate("../../..")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]byte{}
	err = fs.WalkDir(stackFS, "stack", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(stackFS, p)
		got[p] = b
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	for p, b := range want {
		if !bytes.Equal(got[p], b) {
			t.Errorf("%s is stale: run `go generate ./...` in cli/ and commit", p)
		}
	}
	for p := range got {
		if _, ok := want[p]; !ok {
			t.Errorf("%s is embedded but no longer generated: run `go generate ./...`", p)
		}
	}
}

// Adding a service must not need Go: a made-up compose file with one more
// service in a throwaway repo generates, and a host-path bind is refused.
func TestGenerateAddsServiceFromData(t *testing.T) {
	repo := t.TempDir()
	write := func(p, s string) {
		t.Helper()
		_ = os.MkdirAll(filepath.Dir(filepath.Join(repo, p)), 0o755)
		if err := os.WriteFile(filepath.Join(repo, p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("stack/modes.yml", `schema: 2
modes:
  mini:
    title: T
    project: p
    reserve_mib: 1
    publish: [{service: one, container: 80, env: P, default: 8080}]
modules:
  a: {core: true, compose: a/compose.yml, services: [one, two], memory_mib: 1056, modes: [mini], health: {http: [{path: /, contains: x}]}}
`)
	write("a/compose.yml", `services:
  one:
    image: reg.example/team/one:1.2@sha256:`+strings.Repeat("a", 64)+`
    ports: ["80:80", "9:9"]
    networks: [n, solo]
    volumes: ["./cfg:/cfg:ro"]
    deploy: {resources: {limits: {memory: 32m}}}
  two:
    build: .
    image: two:${TAG:-x}
    networks: [n]
    deploy: {resources: {limits: {memory: 1g}}}
networks:
  n: {external: true}
  solo: {external: true}
`)
	out, err := stackgen.Generate(repo)
	if err != nil {
		t.Fatal(err)
	}
	c := string(out["stack/mini/compose.yml.tmpl"])
	for _, must := range []string{"BOTHY_IMAGE_ONE", "BOTHY_IMAGE_TWO", "./one/cfg:/cfg:ro", "${BOTHY_BIND:-127.0.0.1}:${P:-8080}:80", "bothy-n"} {
		if !strings.Contains(c, must) {
			t.Errorf("compose lacks %q:\n%s", must, c)
		}
	}
	for _, mustNot := range []string{"9:9", "solo", "build:", "pull_policy: always"} {
		if strings.Contains(c, mustNot) {
			t.Errorf("compose still has %q", mustNot)
		}
	}
	write("a/compose.yml", strings.Replace(`services:
  one:
    image: one:1
    volumes: ["${HOME}/notes:/n"]
    deploy: {resources: {limits: {memory: 32m}}}
  two:
    image: two:1
    deploy: {resources: {limits: {memory: 32m}}}
`, "\t", "  ", -1))
	if _, err := stackgen.Generate(repo); err == nil || !strings.Contains(err.Error(), "does not have") {
		t.Fatalf("a host bind must be refused, got %v", err)
	}
}

// ---- manifest --------------------------------------------------------------

const commit = "0123456789abcdef0123456789abcdef01234567"

func digest(c byte) string { return "sha256:" + strings.Repeat(string(c), 64) }

func fixture(version string) (manifest, checksums []byte) {
	manifest = []byte(fmt.Sprintf(`{"schema":1,"version":%q,"commit":%q,
 "images":{"bothy-web":{"ref":"ghcr.io/o/bothy-web@%s","platforms":["linux/amd64","linux/arm64"]},
           "bothy-files":{"ref":"ghcr.io/o/bothy-files@%s","platforms":["linux/amd64","linux/arm64"]}},
 "third_party":{"traefik":{"ref":"traefik@%s"}},
 "assets":{"cli":"checksums.txt"}}`, version, commit, digest('a'), digest('c'), digest('b')))
	s := sha256.Sum256(manifest)
	checksums = []byte(hex.EncodeToString(s[:]) + "  release-manifest.json\n" + strings.Repeat("0", 64) + "  bothy_linux_amd64.tar.gz\n")
	return
}

func TestVerifyManifest(t *testing.T) {
	mb, cb := fixture("2026.11.0")
	if _, _, err := VerifyManifest(mb, cb, "2026.11.0", ""); err != nil {
		t.Fatal(err)
	}
	bad := []struct {
		name string
		mb   []byte
		cb   []byte
		ver  string
		pin  string
		want string
	}{
		{"tampered", append(bytes.Clone(mb), ' '), cb, "2026.11.0", "", "does not match checksums.txt"},
		{"wrong pin", mb, cb, "2026.11.0", strings.Repeat("9", 64), "pinned into this binary"},
		{"other version", mb, cb, "2026.12.0", "", "installs exactly the release"},
		{"dev build", mb, cb, "dev", "", "development build"},
		{"no line", mb, []byte(strings.Repeat("0", 64) + "  other\n"), "2026.11.0", "", "no line for release-manifest.json"},
	}
	for _, c := range bad {
		if _, _, err := VerifyManifest(c.mb, c.cb, c.ver, c.pin); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want %q", c.name, err, c.want)
		}
	}
}

func TestManifestRefusesTagsAndUnknownFields(t *testing.T) {
	for name, js := range map[string]string{
		"tag":     `{"schema":1,"version":"1","commit":"` + commit + `","images":{"x":{"ref":"ghcr.io/o/x:latest"}},"third_party":{},"assets":{}}`,
		"unknown": `{"schema":1,"version":"1","commit":"` + commit + `","images":{},"third_party":{},"assets":{},"extra":1}`,
		"schema2": `{"schema":2,"version":"1","commit":"` + commit + `","images":{},"third_party":{},"assets":{}}`,
		"short":   `{"schema":1,"version":"1","commit":"abc","images":{},"third_party":{},"assets":{}}`,
	} {
		if _, err := ParseManifest([]byte(js)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// ---- preflight -------------------------------------------------------------

type fakeHost struct {
	goos, arch string
	euid       int
	mem, disk  int
	fstype     string
	readonly   bool
	env        map[string]string
	listeners  map[int][]string
	cmds       map[string]string // "docker version ..." -> output; prefix "!" = error
	ran        []string
	upCmd      string // when set, the first upFailures runs of this exact command fail
	upFailures int
	ghCode     int    // exit code for a failing ghVerify (default 1)
	ghVerify   string // output of `gh attestation verify ...`; "!" prefix = error
}

func newHost() *fakeHost {
	return &fakeHost{goos: "linux", arch: "amd64", euid: 1000, mem: 4000, disk: 50000, listeners: map[int][]string{},
		cmds: map[string]string{
			"docker version --format {{.Server.Version}}":                                "29.1.3\n",
			"docker compose version --short":                                             "2.40.3\n",
			"docker info --format {{.SecurityOptions}}":                                  "[name=seccomp,profile=builtin]",
			"docker image inspect --format {{.Id}} ghcr.io/o/bothy-web@" + digest('a'):   "!no such image",
			"docker image inspect --format {{.Id}} traefik@" + digest('b'):               "!no such image",
			"docker image inspect --format {{.Id}} ghcr.io/o/bothy-files@" + digest('c'): "!no such image",
		}}
}

func (f *fakeHost) GOOS() string                    { return f.goos }
func (f *fakeHost) GOARCH() string                  { return f.arch }
func (f *fakeHost) Euid() int                       { return f.euid }
func (f *fakeHost) Getenv(k string) string          { return f.env[k] }
func (f *fakeHost) MemAvailableMiB() (int, error)   { return f.mem, nil }
func (f *fakeHost) FreeDiskMiB(string) (int, error) { return f.disk, nil }
func (f *fakeHost) FSType(string) string            { return f.fstype }
func (f *fakeHost) Writable(string) bool            { return !f.readonly }
func (f *fakeHost) ListenAddrs(p int) []string      { return f.listeners[p] }
func (f *fakeHost) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	k := name + " " + strings.Join(args, " ")
	f.ran = append(f.ran, k)
	if k == f.upCmd && f.upFailures > 0 {
		f.upFailures--
		return []byte("container never became healthy"), fmt.Errorf("exit 1")
	}
	if name == "gh" && len(args) > 1 && args[0] == "attestation" {
		if strings.HasPrefix(f.ghVerify, "!") {
			return []byte(f.ghVerify[1:]), exitErr{f.ghCode}
		}
		return []byte(f.ghVerify), nil
	}
	if out, ok := f.cmds[k]; ok {
		if strings.HasPrefix(out, "!") {
			return []byte(out[1:]), fmt.Errorf("exit 1")
		}
		return []byte(out), nil
	}
	if strings.HasPrefix(k, "docker compose") && strings.Contains(k, " ps ") {
		return nil, fmt.Errorf("no such project")
	}
	return nil, fmt.Errorf("unexpected command in test: %s", k)
}

func mini(t *testing.T) *Stack {
	t.Helper()
	st, err := LoadStack("mini")
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func level(cs []Check, id string) Level {
	for _, c := range cs {
		if c.ID == id && c.Level != OK {
			return c.Level
		}
	}
	return OK
}

func TestPreflight(t *testing.T) {
	st := mini(t)
	in := PreflightIn{Stack: st, Bind: "127.0.0.1", DataDir: "/x"}
	pf := func(f *fakeHost) []Check { return Preflight(context.Background(), f, in) }

	if Failed(pf(newHost())) {
		t.Fatalf("clean host failed: %+v", pf(newHost()))
	}
	cases := []struct {
		name string
		mut  func(*fakeHost)
		id   string
		want Level
		fix  string
	}{
		{"macOS", func(f *fakeHost) { f.goos = "darwin" }, "os", Fail, ""},
		{"riscv", func(f *fakeHost) { f.arch = "riscv64" }, "os", Fail, ""},
		{"root", func(f *fakeHost) { f.euid = 0 }, "user", Fail, ""},
		{"old docker", func(f *fakeHost) { f.cmds["docker version --format {{.Server.Version}}"] = "24.0.7" }, "docker", Fail, "start_interval"},
		{"no docker", func(f *fakeHost) {
			f.cmds["docker version --format {{.Server.Version}}"] = `!exec: "docker": executable file not found in $PATH`
		}, "docker", Fail, "needs root"},
		{"not in docker group", func(f *fakeHost) {
			f.cmds["docker version --format {{.Server.Version}}"] = "!permission denied while trying to connect to the Docker daemon socket"
		}, "docker", Fail, "usermod -aG docker"},
		{"daemon down", func(f *fakeHost) {
			f.cmds["docker version --format {{.Server.Version}}"] = "!Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
		}, "docker", Fail, "systemctl start docker"},
		{"no compose", func(f *fakeHost) { f.cmds["docker compose version --short"] = "!unknown command" }, "compose", Fail, "docker-compose-v2"},
		{"rootless", func(f *fakeHost) { f.cmds["docker info --format {{.SecurityOptions}}"] = "[name=rootless]" }, "rootless", Fail, ""},
		{"RAM gate", func(f *fakeHost) { f.mem = 600 }, "memory", Fail, "k3s"},
		{"disk", func(f *fakeHost) { f.disk = 100 }, "disk", Fail, "--root"},
		{"9p", func(f *fakeHost) { f.fstype = "9p" }, "filesystem", Fail, ""},
		{"port taken wildcard", func(f *fakeHost) { f.listeners[80] = []string{"0.0.0.0"} }, "port", Fail, "--port"},
		{"port taken same ip", func(f *fakeHost) { f.listeners[80] = []string{"127.0.0.1"} }, "port", Fail, ""},
	}
	for _, c := range cases {
		f := newHost()
		c.mut(f)
		cs := pf(f)
		if got := level(cs, c.id); got != c.want {
			t.Errorf("%s: %s is %s, want %s: %+v", c.name, c.id, got, c.want, cs)
		}
		if c.fix != "" {
			joined := ""
			for _, x := range cs {
				joined += x.Fix + " " + x.Msg
			}
			if !strings.Contains(joined, c.fix) {
				t.Errorf("%s: fix text lacks %q: %s", c.name, c.fix, joined)
			}
		}
	}
	// A listener on another address does not block 127.0.0.1.
	f := newHost()
	f.listeners[80] = []string{"10.0.0.5"}
	if level(pf(f), "port") != OK {
		t.Error("a listener on another address blocked the bind")
	}
	// The same install holding its own port is fine.
	f = newHost()
	f.listeners[80] = []string{"0.0.0.0"}
	in2 := in
	in2.OwnPortsOK = true
	if Failed(Preflight(context.Background(), f, in2)) {
		t.Error("own port counted as a conflict")
	}
	// No sudo anywhere.
	for _, r := range newHost().ran {
		if strings.Contains(r, "sudo") {
			t.Error("sudo was run")
		}
	}
}

func TestSysHostRefusesNonDocker(t *testing.T) {
	if _, err := (SysHost{}).Run(context.Background(), "sudo", "true"); err == nil {
		t.Fatal("SysHost ran sudo")
	}
}

func TestHexAddr(t *testing.T) {
	for in, want := range map[string]string{
		"0100007F": "127.0.0.1", "00000000": "0.0.0.0", "00000000000000000000000000000000": "::",
		"0000000000000000FFFF00000100007F": "127.0.0.1",
	} {
		if got := hexAddr(in); got != want {
			t.Errorf("%s -> %s, want %s", in, got, want)
		}
	}
}

// ---- plan and dry run ------------------------------------------------------

func writeRelease(t *testing.T, version string) (dir, mpath, cpath string) {
	dir = t.TempDir()
	mb, cb := fixture(version)
	mpath, cpath = filepath.Join(dir, "release-manifest.json"), filepath.Join(dir, "checksums.txt")
	if err := os.WriteFile(mpath, mb, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cpath, cb, 0o644); err != nil {
		t.Fatal(err)
	}
	return
}

func opts(t *testing.T) Options {
	_, mp, cp := writeRelease(t, "2026.11.0")
	root := t.TempDir()
	return Options{Mode: "mini", Bind: "127.0.0.1", DataDir: filepath.Join(root, "data", "bothy"), ConfigDir: filepath.Join(root, "cfg", "bothy"),
		ManifestSrc: mp, ChecksumsSrc: cp, BinaryVersion: "2026.11.0", DryRun: true}
}

func TestDryRunPrintsEveryActionAndChangesNothing(t *testing.T) {
	o := opts(t)
	var out bytes.Buffer
	h := newHost()
	if err := Install(context.Background(), h, o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	s := out.String()
	for _, want := range []string{
		"create 6 directories", "generate " + filepath.Join(o.ConfigDir, "secrets", "master.key"), "never printed",
		"record the install", "write .env, bothy-files/policy/policy.toml, compose.yml, traefik/dynamic/routes.yml", "docker pull ghcr.io/o/bothy-files@" + digest('c'), "docker pull ghcr.io/o/bothy-web@" + digest('a'), "docker pull traefik@" + digest('b'),
		"docker compose up -d --wait --pull never", "byte", "needs root: nothing", "dry run: nothing was changed",
		"matches checksums.txt",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("dry run output lacks %q:\n%s", want, s)
		}
	}
	for _, p := range []string{o.DataDir, o.ConfigDir} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("dry run created %s", p)
		}
	}
	for _, r := range h.ran {
		if strings.Contains(r, " pull ") || strings.Contains(r, " up ") || strings.Contains(r, "sudo") {
			t.Errorf("dry run ran %q", r)
		}
	}
}

func TestInstallRefusesOnFailedPreflightAndChangesNothing(t *testing.T) {
	o := opts(t)
	o.DryRun = false
	h := newHost()
	h.mem = 100
	var out bytes.Buffer
	err := Install(context.Background(), h, o, &out)
	if err != ErrPreflight {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(o.DataDir); err == nil {
		t.Fatal("data dir created despite failed preflight")
	}
}

func TestInstallRefusesAMismatchedBinary(t *testing.T) {
	o := opts(t)
	o.BinaryVersion = "2026.12.0"
	if err := Install(context.Background(), newHost(), o, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "installs exactly the release") {
		t.Fatalf("got %v", err)
	}
}

// A full apply against fakes: files land with the right modes, the receipt is
// complete, a re-run plans nothing, and a failed `up` rolls back and is resumable.
func TestApplyIdempotentAndResumable(t *testing.T) {
	o := opts(t)
	o.DryRun = false
	web := []byte("<html>portal</html>")
	o.HTTPGet = func(u string) (int, []byte, error) {
		if strings.HasSuffix(u, "/version.json") {
			return 200, []byte(`{"revision":"` + commit + `"}`), nil
		}
		return 200, web, nil
	}
	h := newHost()
	have := map[string]bool{}
	up := false
	base := h.cmds
	h.cmds = map[string]string{}
	for k, v := range base {
		h.cmds[k] = v
	}
	pull := func(ref string) {
		h.cmds["docker pull --quiet "+ref] = ref
		h.cmds["docker image inspect --format {{json .RepoDigests}} "+ref] = `["` + ref + `"]`
	}
	pull("ghcr.io/o/bothy-web@" + digest('a'))
	pull("traefik@" + digest('b'))
	pull("ghcr.io/o/bothy-files@" + digest('c'))
	st := mini(t)
	ca := func(more ...string) string { return "docker " + strings.Join(o.composeArgs(st, more...), " ") }
	h.cmds[ca("up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", "--remove-orphans")] = ""
	h.cmds[ca("exec", "-T", "bothy-web", "cat", "/usr/share/nginx/html/index.html")] = string(web)
	h.cmds[ca("down", "--remove-orphans")] = ""
	_ = have
	_ = up

	var out bytes.Buffer
	// First: `up` fails.
	h.cmds[ca("up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", "--remove-orphans")] = "!boom"
	err := Install(context.Background(), h, o, &out)
	if err == nil || !strings.Contains(out.String(), "rolling back") || !strings.Contains(out.String(), "resume") {
		t.Fatalf("expected a rolled-back failure, got %v\n%s", err, out.String())
	}
	r, _ := readReceipt(o.receiptPath())
	if r == nil || r.Status != "in-progress" || r.LastError == "" {
		t.Fatalf("receipt after failure: %+v", r)
	}
	if !contains(h.ran, ca("down", "--remove-orphans")) {
		t.Fatal("no compose down after the failed first install")
	}
	// Resume: `up` works now; finished steps are skipped.
	h.cmds[ca("up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", "--remove-orphans")] = ""
	for _, ref := range []string{"ghcr.io/o/bothy-web@" + digest('a'), "traefik@" + digest('b'), "ghcr.io/o/bothy-files@" + digest('c')} {
		h.cmds["docker image inspect --format {{.Id}} "+ref] = "sha256:id"
	}
	out.Reset()
	if err := Install(context.Background(), h, o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "Bivvy is up") || !strings.Contains(out.String(), "byte-identical") {
		t.Fatalf("no success line:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "skip  dirs") {
		t.Errorf("resume did not skip finished steps:\n%s", out.String())
	}
	r, _ = readReceipt(o.receiptPath())
	if r.Status != "complete" || r.Version != "2026.11.0" || r.Images["BOTHY_IMAGE_TRAEFIK"] != "traefik@"+digest('b') {
		t.Fatalf("receipt: %+v", r)
	}
	// modes
	for p, want := range map[string]os.FileMode{
		o.secretsDir(): 0o700, filepath.Join(o.secretsDir(), "master.key"): 0o600, o.ConfigDir: 0o700,
		filepath.Join(o.stackDir(), ".env"): 0o600, o.receiptPath(): 0o600,
	} {
		fi, err := os.Stat(p)
		if err != nil || fi.Mode().Perm() != want {
			t.Errorf("%s: %v %v, want %o", p, fi, err, want)
		}
	}
	key1, _ := os.ReadFile(filepath.Join(o.secretsDir(), "master.key"))
	if _, perr := parseMasterKey(key1); perr != nil || bytes.Contains(out.Bytes(), key1[len(keyHeader)+18:len(keyHeader)+34]) {
		t.Errorf("master key malformed or printed")
	}
	// Re-run: `ps` now reports everything running; plan must be empty.
	h.cmds[ca("ps", "--format", "json")] = `{"Service":"bothy-web","State":"running","Health":"healthy"}
{"Service":"traefik","State":"running","Health":"healthy"}
{"Service":"bothy-files","State":"running","Health":"healthy"}
`
	out.Reset()
	h.ran = nil
	if err := Install(context.Background(), h, o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "nothing to do") {
		t.Fatalf("re-run was not a no-op:\n%s", out.String())
	}
	for _, r := range h.ran {
		if strings.Contains(r, " up ") || strings.Contains(r, " pull ") {
			t.Errorf("re-run ran %q", r)
		}
	}
	key2, _ := os.ReadFile(filepath.Join(o.secretsDir(), "master.key"))
	if !bytes.Equal(key1, key2) {
		t.Error("re-run rotated the master key")
	}
	// A catch-all answering for /version.json is caught.
	o.HTTPGet = func(string) (int, []byte, error) { return 200, []byte("<html>"), nil }
	out.Reset()
	if err := Install(context.Background(), h, o, &out); err == nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("catch-all html passed verification: %v", err)
	}
	// A downgrade is refused.
	_, mp, cp := writeRelease(t, "2026.10.0")
	o.ManifestSrc, o.ChecksumsSrc, o.BinaryVersion = mp, cp, "2026.10.0"
	if err := Install(context.Background(), h, o, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "downgrade") {
		t.Fatalf("downgrade: %v", err)
	}

	// ---- uninstall ----
	uo := UninstallOptions{DataDir: o.DataDir, ConfigDir: o.ConfigDir, DryRun: true}
	out.Reset()
	if err := Uninstall(context.Background(), h, uo, &out); err != nil || !strings.Contains(out.String(), "dry run") {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if _, err := os.Stat(o.receiptPath()); err != nil {
		t.Fatal("dry-run uninstall removed the receipt")
	}
	// Plain uninstall keeps secrets.
	uo.DryRun = false
	if err := Uninstall(context.Background(), h, uo, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(o.secretsDir(), "master.key")); err != nil {
		t.Fatal("plain uninstall deleted the secret")
	}
	if _, err := os.Stat(o.receiptPath()); err == nil {
		t.Fatal("receipt still there")
	}
	if _, err := os.Stat(filepath.Join(o.stackDir(), "compose.yml")); err == nil {
		t.Fatal("generated compose.yml still there")
	}
	// Re-install, then purge: wrong phrase deletes nothing, right phrase deletes.
	o.BinaryVersion = "2026.11.0"
	_, o.ManifestSrc, o.ChecksumsSrc = writeRelease(t, "2026.11.0")
	o.HTTPGet = func(u string) (int, []byte, error) {
		if strings.HasSuffix(u, "/version.json") {
			return 200, []byte(`{"revision":"` + commit + `"}`), nil
		}
		return 200, web, nil
	}
	if err := Install(context.Background(), h, o, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	uo.Purge = true
	uo.In = strings.NewReader("yes\n")
	if err := Uninstall(context.Background(), h, uo, &bytes.Buffer{}); err == nil {
		t.Fatal("purge accepted the wrong phrase")
	}
	if _, err := os.Stat(o.receiptPath()); err != nil {
		t.Fatal("a refused purge removed data")
	}
	uo.In = strings.NewReader(PurgePhrase + "\n")
	if err := Uninstall(context.Background(), h, uo, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(o.DataDir); err == nil {
		t.Fatal("purge left the install root")
	}
}

// ---- slice-1 rule ----------------------------------------------------------

// The read-only MCP server must not reach the installer, directly or not.
func TestMCPServerDoesNotDependOnInstall(t *testing.T) {
	cmd := exec.Command("go", "list", "-deps", "../mcpserver")
	cmd.Env = append(os.Environ(), "GOFLAGS=-mod=mod")
	out, err := cmd.Output()
	if err != nil {
		t.Skipf("go list unavailable: %v", err)
	}
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasSuffix(l, "/internal/install") || strings.HasSuffix(l, "/internal/stackgen") {
			t.Fatalf("internal/mcpserver depends on %s", l)
		}
	}
}

// exitErr is a command failure carrying an exit code, like *exec.ExitError.
type exitErr struct{ code int }

func (e exitErr) Error() string { return fmt.Sprintf("exit status %d", e.code) }
func (e exitErr) ExitCode() int { return e.code }
