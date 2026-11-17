package install

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func joinChecks(cs []Check, id string) string {
	var s []string
	for _, c := range cs {
		if c.ID == id {
			s = append(s, string(c.Level)+" "+c.Msg+" | "+c.Fix)
		}
	}
	return strings.Join(s, "\n")
}

func TestPreflightRealMachines(t *testing.T) {
	st := mini(t)
	in := PreflightIn{Stack: st, Bind: "127.0.0.1", DataDir: "/x", RealDataDir: "/x/bothy", ConfigDir: "/c/bothy", StackDir: "/x/bothy/stack"}
	run := func(f *fakeHost, in PreflightIn) []Check { return Preflight(context.Background(), f, in) }

	t.Run("Docker Desktop WSL integration off", func(t *testing.T) {
		f := newHost()
		f.cmds["docker version --format {{.Server.Version}}"] = "!The command 'docker' could not be found in this WSL 2 distro.\nWe recommend to activate the WSL integration in Docker Desktop settings."
		got := joinChecks(run(f, in), "docker")
		if !strings.Contains(got, "WSL integration") || strings.Contains(got, "daemon is not answering") {
			t.Fatal(got)
		}
	})
	t.Run("port 80 taken by a container: names it, suggests a free port, stops nothing", func(t *testing.T) {
		f := newHost()
		f.listeners[80] = []string{"0.0.0.0"}
		f.cmds["docker ps --filter publish=80 --format {{.Names}}"] = "stacks-traefik-1\n"
		got := joinChecks(run(f, in), "port")
		for _, w := range []string{"fail", "stacks-traefik-1", "--port 8080", "Nothing was stopped"} {
			if !strings.Contains(got, w) {
				t.Errorf("lacks %q: %s", w, got)
			}
		}
		for _, r := range f.ran {
			if strings.Contains(r, " stop") || strings.Contains(r, " rm") || strings.Contains(r, " kill") {
				t.Errorf("ran %q", r)
			}
		}
	})
	t.Run("suggestion skips a busy alternative", func(t *testing.T) {
		f := newHost()
		f.listeners[80] = []string{"0.0.0.0"}
		f.listeners[8080] = []string{"0.0.0.0"}
		if got := joinChecks(run(f, in), "port"); !strings.Contains(got, "--port 8081") {
			t.Error(got)
		}
	})
	t.Run("a different bothy compose project is refused, ours is not", func(t *testing.T) {
		f := newHost()
		f.cmds[`docker ps -a --filter label=com.docker.compose.project=bothy --format {{.Label "com.docker.compose.project.working_dir"}}`] = "/home/u/Bothy/stack\n"
		got := joinChecks(run(f, in), "project")
		if !strings.Contains(got, "fail") || !strings.Contains(got, "/home/u/Bothy/stack") || !strings.Contains(got, "will not adopt") {
			t.Fatal(got)
		}
		f.cmds[`docker ps -a --filter label=com.docker.compose.project=bothy --format {{.Label "com.docker.compose.project.working_dir"}}`] = "/x/bothy/stack\n/x/bothy/stack\n"
		if got := joinChecks(run(f, in), "project"); got != "" {
			t.Fatal("our own project was refused: " + got)
		}
	})
	t.Run("read-only or unowned home", func(t *testing.T) {
		f := newHost()
		f.readonly = true
		got := joinChecks(run(f, in), "writable")
		if !strings.Contains(got, "fail") || !strings.Contains(got, "--root") || !strings.Contains(got, "Nothing was created") {
			t.Fatal(got)
		}
	})
	t.Run("colon in the path", func(t *testing.T) {
		in2 := in
		in2.RealDataDir = "/mnt/a:b/bothy"
		if got := joinChecks(run(newHost(), in2), "path"); !strings.Contains(got, "fail") {
			t.Fatal(got)
		}
	})
	t.Run("spaces and unicode are fine", func(t *testing.T) {
		in2 := in
		in2.RealDataDir, in2.ConfigDir = "/home/José Smith/my docs/bothy", "/home/José Smith/.config/bothy"
		if Failed(run(newHost(), in2)) {
			t.Fatal("refused a path with spaces/unicode")
		}
	})
	t.Run("docker data-root disk is checked, not just the install root", func(t *testing.T) {
		f := newHost()
		f.cmds["docker info --format {{.DockerRootDir}}"] = "/var/lib/docker\n"
		f.disk = 1000 // enough? no: below MinImageDiskMiB
		got := joinChecks(run(f, in), "docker-disk")
		if !strings.Contains(got, "fail") || !strings.Contains(got, "data-root") {
			t.Fatal(got)
		}
		f.disk = 50000
		if got := joinChecks(run(f, in), "docker-disk"); got != "" {
			t.Fatal(got)
		}
	})
	t.Run("SELinux warns, does not block", func(t *testing.T) {
		f := newHost()
		f.cmds["docker info --format {{.SecurityOptions}}"] = "[name=seccomp,profile=builtin name=selinux]"
		cs := run(f, in)
		if level(cs, "selinux") != Warn || Failed(cs) {
			t.Fatalf("%+v", cs)
		}
	})
	t.Run("under sudo", func(t *testing.T) {
		f := newHost()
		f.euid = 0
		f.env = map[string]string{"SUDO_USER": "dana"}
		got := joinChecks(run(f, in), "user")
		if !strings.Contains(got, "dana") || !strings.Contains(got, "without sudo") {
			t.Fatal(got)
		}
	})
	t.Run("low RAM names the figures", func(t *testing.T) {
		f := newHost()
		f.mem = 500
		got := joinChecks(run(f, in), "memory")
		if !strings.Contains(got, "500 MiB available") || !strings.Contains(got, "960 MiB needed") {
			t.Fatal(got)
		}
	})
}

func TestNetHint(t *testing.T) {
	for in, want := range map[string]string{
		"write /var/lib/docker/x: no space left on device":                                     "disk is full",
		"tls: failed to verify certificate: x509: certificate has expired or is not yet valid": "clock",
		"x509: certificate signed by unknown authority":                                        "corporate proxy",
		"toomanyrequests: You have reached your pull rate limit":                               "rate-limiting",
		"Get \"https://ghcr.io/v2/\": dial tcp: lookup ghcr.io: no such host":                  "offline",
		"Get \"https://ghcr.io/v2/\": net/http: TLS handshake timeout":                         "blocked the connection",
		"dial tcp 140.82.1.1:443: i/o timeout":                                                 "blocked the connection",
		"error pulling image: unauthorized: authentication required":                           "docker login",
		"pull access denied, requested access to the resource is denied":                       "docker login",
		"proxyconnect tcp: dial tcp 10.0.0.1:3128: connect: connection refused":                "Docker DAEMON",
	} {
		if got := netHint(in); !strings.Contains(got, want) {
			t.Errorf("%q: hint %q lacks %q", in, got, want)
		}
	}
	// A digest that happens to contain "429" or "eof" must not look like a rate limit.
	if h := netHint("failed to resolve reference ghcr.io/o/x@sha256:ab429eofcd: not found"); h != "" {
		t.Errorf("false positive: %s", h)
	}
}

// applyFixture is a host where every command of a clean install succeeds.
func applyFixture(t *testing.T) (*fakeHost, Options, func(...string) string) {
	t.Helper()
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
	for _, ref := range []string{"ghcr.io/o/bothy-web@" + digest('a'), "traefik@" + digest('b'), "ghcr.io/o/bothy-files@" + digest('c')} {
		h.cmds["docker pull --quiet "+ref] = ref
		h.cmds["docker image inspect --format {{json .RepoDigests}} "+ref] = `["` + ref + `"]`
	}
	st := mini(t)
	ca := func(more ...string) string { return "docker " + strings.Join(o.composeArgs(st, more...), " ") }
	h.cmds[ca("up", "-d", "--wait", "--wait-timeout", "180", "--pull", "never", "--remove-orphans")] = ""
	h.cmds[ca("exec", "-T", "bothy-web", "cat", "/usr/share/nginx/html/index.html")] = string(web)
	h.cmds[ca("down", "--remove-orphans")] = ""
	return h, o, ca
}

// cancelHost cancels the run's context the moment `up` starts (a Ctrl-C), and
// refuses any later command that is given that cancelled context.
type cancelHost struct {
	*fakeHost
	cancel context.CancelFunc
	downOK bool
}

func (c *cancelHost) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	k := name + " " + strings.Join(args, " ")
	if strings.Contains(k, " up -d ") {
		c.cancel()
		return []byte("signal: killed"), context.Canceled
	}
	if ctx.Err() != nil {
		return nil, ctx.Err() // exec.CommandContext would not even start
	}
	if strings.Contains(k, " down --remove-orphans") {
		c.downOK = true
	}
	return c.fakeHost.Run(ctx, name, args...)
}

func TestInterruptedInstallCleansUpAndResumes(t *testing.T) {
	h, o, ca := applyFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	ch := &cancelHost{fakeHost: h, cancel: cancel}
	var out bytes.Buffer
	err := Install(ctx, ch, o, &out)
	if err == nil || !strings.Contains(out.String(), "INTERRUPTED") || !strings.Contains(err.Error(), "interrupted") {
		t.Fatalf("got %v\n%s", err, out.String())
	}
	if !ch.downOK {
		t.Fatalf("the cleanup `compose down` did not run after the interrupt (it was handed the cancelled context):\n%s", out.String())
	}
	r, _ := readReceipt(o.receiptPath())
	if r == nil || r.Status != "in-progress" || !strings.Contains(r.LastError, "interrupted") {
		t.Fatalf("receipt: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(o.DataDir, ".install.lock")); err == nil {
		t.Error("lock file left behind")
	}
	if b, _ := os.ReadFile(filepath.Join(o.secretsDir(), "master.key")); len(strings.TrimSpace(string(b))) != 64 {
		t.Error("master key missing after an interrupt")
	}
	// Resume with a fresh context: finished steps skip, it completes.
	for _, ref := range []string{"ghcr.io/o/bothy-web@" + digest('a'), "traefik@" + digest('b'), "ghcr.io/o/bothy-files@" + digest('c')} {
		h.cmds["docker image inspect --format {{.Id}} "+ref] = "sha256:id"
	}
	out.Reset()
	if err := Install(context.Background(), h, o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "Bivvy is up") || !strings.Contains(out.String(), "skip  dirs") || !strings.Contains(out.String(), "skip  pull") {
		t.Fatalf("resume:\n%s", out.String())
	}
	_ = ca
}

// An interrupted run whose containers are still up must not be told that its
// own port is "in use" when it is resumed.
func TestResumeDoesNotFightItsOwnPort(t *testing.T) {
	h, o, ca := applyFixture(t)
	if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeReceipt(o.receiptPath(), &Receipt{Status: "in-progress", Mode: "mini", Version: "2026.11.0", Bind: o.Bind, Port: 80, DataDir: o.DataDir}); err != nil {
		t.Fatal(err)
	}
	h.listeners[80] = []string{"127.0.0.1"}
	// nothing of ours is up: the listener is somebody else's, the run must refuse
	o2 := o
	o2.DryRun = true
	var out bytes.Buffer
	if err := Install(context.Background(), h, o2, &out); err != ErrPreflight {
		t.Fatalf("a foreign listener was accepted: %v\n%s", err, out.String())
	}
	// our containers are up: that is our own port
	h.cmds[ca("ps", "-q")] = "abc123\n"
	out.Reset()
	if err := Install(context.Background(), h, o2, &out); err != nil {
		t.Fatalf("own port refused: %v\n%s", err, out.String())
	}
}

func TestSecondInstallIsRefusedWhileOneRuns(t *testing.T) {
	h, o, _ := applyFixture(t)
	release, err := lockInstall(o.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err = Install(context.Background(), h, o, &out)
	if err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("got %v", err)
	}
	for _, r := range h.ran {
		if strings.Contains(r, " pull ") || strings.Contains(r, " up ") {
			t.Errorf("the second run touched Docker: %s", r)
		}
	}
	release()
	if _, err := os.Stat(o.DataDir); err == nil {
		t.Error("the lock left the root behind")
	}
}

func TestFailedPreflightLeavesNoDirectoryBehind(t *testing.T) {
	h, o, _ := applyFixture(t)
	h.listeners[80] = []string{"0.0.0.0"}
	if err := Install(context.Background(), h, o, &bytes.Buffer{}); err != ErrPreflight {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(o.DataDir)); err == nil {
		t.Error("an empty parent directory chain was left behind")
	}
	if _, err := os.Stat(o.ConfigDir); err == nil {
		t.Error("config dir created")
	}
}

func TestEmptyMasterKeyIsRegeneratedAndNeverTheOtherWay(t *testing.T) {
	h, o, _ := applyFixture(t)
	if err := os.MkdirAll(o.secretsDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(o.secretsDir(), "master.key")
	if err := os.WriteFile(key, nil, 0o600); err != nil { // an interrupted write
		t.Fatal(err)
	}
	if err := Install(context.Background(), h, o, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(key)
	if len(strings.TrimSpace(string(b))) != 64 {
		t.Fatalf("key not regenerated: %q", b)
	}
	if _, err := os.Stat(key + ".tmp"); err == nil {
		t.Error("temp key left behind")
	}
	// an existing real key is never touched
	h2, o2, _ := applyFixture(t)
	_ = os.MkdirAll(o2.secretsDir(), 0o700)
	k2 := filepath.Join(o2.secretsDir(), "master.key")
	_ = os.WriteFile(k2, []byte("mine\n"), 0o600)
	if err := Install(context.Background(), h2, o2, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(k2); string(b) != "mine\n" {
		t.Errorf("an existing key was replaced: %q", b)
	}
}

func TestPullFailurePrintsAHintAndResumes(t *testing.T) {
	h, o, _ := applyFixture(t)
	h.cmds["docker pull --quiet ghcr.io/o/bothy-web@"+digest('a')] = "!Error response from daemon: Get \"https://ghcr.io/v2/\": dial tcp: lookup ghcr.io: no such host"
	var out bytes.Buffer
	err := Install(context.Background(), h, o, &out)
	if err == nil || !strings.Contains(out.String(), "hint:") || !strings.Contains(out.String(), "offline") || !strings.Contains(out.String(), "again to resume") {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if r, _ := readReceipt(o.receiptPath()); r == nil || r.Status != "in-progress" {
		t.Fatalf("receipt: %+v", r)
	}
	for _, r := range h.ran {
		if strings.Contains(r, " up ") {
			t.Errorf("went on to `up` after a failed pull: %s", r)
		}
	}
}
