package install

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// Host is everything preflight and apply ask of the machine, so tests can fake
// it. Nothing here runs a privileged command: there is no sudo anywhere in this
// package, and Run is only ever given docker.
type Host interface {
	GOOS() string
	GOARCH() string
	Euid() int
	Getenv(string) string
	// Run executes a command and returns combined output.
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	MemAvailableMiB() (int, error)
	FreeDiskMiB(dir string) (int, error)
	FSType(dir string) string
	// ListenAddrs returns the local addresses (as dotted/colon text) with a
	// TCP listener on port.
	ListenAddrs(port int) []string
	// Writable reports whether this user can create files in dir (an existing
	// directory; callers pass the nearest existing parent).
	Writable(dir string) bool
}

type Level string

const (
	OK   Level = "ok"
	Warn Level = "warn"
	Fail Level = "fail"
)

// Check is one preflight line. Fix says what the person can do, in words; the
// installer never does it for them when it needs root.
type Check struct {
	ID    string
	Level Level
	Msg   string
	Fix   string
}

// Minimums. Engine 25 because the stack's healthchecks use start_interval.
const (
	MinEngine  = "25.0.0"
	MinCompose = "2.24.0"
	MinDiskMiB = 2048
	// MinImageDiskMiB: the three images unpack to about 450 MB; leave room for layers.
	MinImageDiskMiB = 1536
	DefaultPort     = 80
)

// PreflightIn is what preflight needs to know about the intended install.
type PreflightIn struct {
	Stack       *Stack
	Manifest    *Manifest // nil: image checks are skipped (offline dry run)
	Bind        string
	Port        int
	DataDir     string
	OwnPortsOK  bool // true when this install's own containers already hold the port
	ConfigDir   string
	RealDataDir string // the install root as asked for (it may not exist yet; DataDir is its nearest existing parent)
	StackDir    string // where this install's compose project lives (to tell ours from someone else's "bothy")
}

// Preflight is read-only. It never changes anything and never asks for root.
func Preflight(ctx context.Context, h Host, in PreflightIn) []Check {
	var cs []Check
	add := func(id string, l Level, msg, fix string) { cs = append(cs, Check{id, l, msg, fix}) }

	if h.GOOS() != "linux" {
		add("os", Fail, fmt.Sprintf("%s is not supported by this installer yet", h.GOOS()),
			"Only Linux hosts (including WSL2) are supported; Docker Desktop hosts are a later step.")
	} else if a := h.GOARCH(); a != "amd64" && a != "arm64" {
		add("os", Fail, "unsupported CPU architecture "+a, "Bothy images are built for linux/amd64 and linux/arm64.")
	} else {
		add("os", OK, "linux/"+h.GOARCH(), "")
	}

	if h.Euid() == 0 {
		if su := h.Getenv("SUDO_USER"); su != "" {
			add("user", Warn, fmt.Sprintf("running under sudo (as root, on behalf of %s): files written as root may land in a home directory that belongs to %s", su, su),
				fmt.Sprintf("Run it without sudo as %s (add them to the docker group once: `sudo usermod -aG docker %s`, then log in again).", su, su))
		} else {
			add("user", Warn, "running as root: files will go under root's home and the stack is owned by root",
				"Prefer a normal user who is in the docker group.")
		}
	} else {
		add("user", OK, fmt.Sprintf("running as uid %d (no root needed)", h.Euid()), "")
	}

	// docker CLI, then daemon access, then versions.
	if out, err := h.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}"); err != nil {
		cs = append(cs, dockerFailure(string(out), err))
	} else {
		v := strings.TrimSpace(string(out))
		if cmpVersion(v, MinEngine) < 0 {
			add("docker", Fail, fmt.Sprintf("Docker Engine %s is older than %s", v, MinEngine),
				"Update Docker Engine (this stack's healthchecks need start_interval, Engine 25+).")
		} else {
			add("docker", OK, "Docker Engine "+v, "")
		}
	}
	if out, err := h.Run(ctx, "docker", "compose", "version", "--short"); err != nil {
		add("compose", Fail, "the Docker Compose plugin is missing or broken",
			"Install the compose plugin (Ubuntu: `sudo apt install docker-compose-v2`; Docker's own repo: docker-compose-plugin).")
	} else if v := strings.TrimSpace(strings.TrimPrefix(string(out), "v")); cmpVersion(v, MinCompose) < 0 {
		add("compose", Fail, fmt.Sprintf("Docker Compose %s is older than %s", v, MinCompose), "Update the compose plugin.")
	} else {
		add("compose", OK, "Docker Compose "+v, "")
	}
	if out, err := h.Run(ctx, "docker", "info", "--format", "{{.SecurityOptions}}"); err == nil && strings.Contains(string(out), "rootless") {
		add("rootless", Fail, "rootless Docker is not supported yet (untested: published-port and bind-mount ownership rules differ; the edge no longer needs the socket)",
			"Use a rootful Docker daemon for now.")
	}

	if out, err := h.Run(ctx, "docker", "info", "--format", "{{.SecurityOptions}}"); err == nil && strings.Contains(string(out), "selinux") {
		add("selinux", Warn, "SELinux is enabled in Docker: the containers may be denied the bind-mounted directories (permission denied inside Traefik or files)",
			"If the stack starts but routes fail, label the install root: `chcon -R -t container_file_t "+in.DataDir+"`. Not proven on a real SELinux host.")
	}
	// Free disk where DOCKER stores images (its data-root may be elsewhere than the install root).
	if out, err := h.Run(ctx, "docker", "info", "--format", "{{.DockerRootDir}}"); err == nil {
		if dr := strings.TrimSpace(string(out)); strings.HasPrefix(dr, "/") {
			d := dr
			for !h.Writable(d) && d != "/" && d != "." { // /var/lib/docker is 0710 root: measure the nearest parent we can stat
				d = filepath.Dir(d)
			}
			if free, err := h.FreeDiskMiB(d); err == nil && free < MinImageDiskMiB {
				add("docker-disk", Fail, fmt.Sprintf("%d MiB free where Docker stores images (%s), %d MiB needed for the pulls", free, dr, MinImageDiskMiB),
					"Free space there (`docker system df`, `docker image prune`), or move Docker's data-root (daemon.json \"data-root\").")
			}
		}
	}
	// Something else already called "bothy" in Compose would be adopted and
	// recreated by `up`. Never touch what is not ours.
	if in.StackDir != "" {
		if out, err := h.Run(ctx, "docker", "ps", "-a", "--filter", "label=com.docker.compose.project=bothy", "--format", `{{.Label "com.docker.compose.project.working_dir"}}`); err == nil {
			for _, wd := range strings.Fields(string(out)) {
				if filepath.Clean(wd) != filepath.Clean(in.StackDir) {
					add("project", Fail, fmt.Sprintf("a Docker Compose project named \"bothy\" already exists, started from %s (not this install)", wd),
						"Bothy will not adopt or replace it. Stop it where it was started (`docker compose -p bothy down` from that directory) and run this again.")
					break
				}
			}
		}
	}

	// RAM gate (D13): the stack's own limits plus the reserve must fit in MemAvailable.
	need := in.Stack.Meta.ReserveMiB
	for _, s := range in.Stack.Meta.Services {
		need += s.MemMiB
	}
	if avail, err := h.MemAvailableMiB(); err != nil {
		add("memory", Warn, "could not read MemAvailable: "+err.Error(), "")
	} else if avail < need {
		add("memory", Fail, fmt.Sprintf("%d MiB available, %d MiB needed (%d MiB of container limits + %d MiB reserve)", avail, need, need-in.Stack.Meta.ReserveMiB, in.Stack.Meta.ReserveMiB),
			"Free memory or stop something. This installer is the Compose runtime; k3s (4 GiB floor, D13) is not offered here.")
	} else {
		add("memory", OK, fmt.Sprintf("%d MiB available, %d MiB needed", avail, need), "")
	}

	for _, d := range []string{in.RealDataDir, in.ConfigDir} {
		if d == "" {
			continue
		}
		if strings.Contains(d, ":") {
			add("path", Fail, fmt.Sprintf("%s contains a ':' which Docker Compose bind-mount syntax cannot express", d), "Use --root and --config-dir paths without a colon.")
		}
		if !h.Writable(nearest(d)) {
			add("writable", Fail, fmt.Sprintf("this user cannot create files under %s (read-only filesystem or not yours)", d),
				"Pick a writable place with --root / --config-dir (both directories must be named \"bothy\"), or fix the permissions. Nothing was created.")
		}
	}
	// Disk and filesystem under the data directory.
	if free, err := h.FreeDiskMiB(in.DataDir); err != nil {
		add("disk", Warn, "could not measure free disk at "+in.DataDir+": "+err.Error(), "")
	} else if free < MinDiskMiB {
		add("disk", Fail, fmt.Sprintf("%d MiB free at %s, %d MiB needed", free, in.DataDir, MinDiskMiB), "Free disk space or choose --root on a bigger filesystem.")
	} else {
		add("disk", OK, fmt.Sprintf("%d MiB free at %s", free, in.DataDir), "")
	}
	switch fs := h.FSType(in.DataDir); fs {
	case "9p", "drvfs", "nfs", "cifs", "fuseblk", "fuse", "virtiofs":
		add("filesystem", Fail, fmt.Sprintf("%s is on a %s filesystem", in.DataDir, fs), "Use --root on a local ext4/xfs/btrfs path.")
	}

	// Ports: a listener we can see. Docker binds as root, so a bind() test as
	// this user would lie for port 80; the kernel's table does not.
	for _, p := range in.Stack.Meta.Publish {
		port := in.Port
		if port == 0 {
			port = p.Default
		}
		if in.OwnPortsOK {
			add("port", OK, fmt.Sprintf("%s:%d is held by this install", in.Bind, port), "")
			continue
		}
		if conflict(in.Bind, h.ListenAddrs(port)) {
			who := ""
			if out, err := h.Run(ctx, "docker", "ps", "--filter", fmt.Sprintf("publish=%d", port), "--format", "{{.Names}}"); err == nil {
				if n := strings.Fields(string(out)); len(n) > 0 {
					who = " (a Docker container publishes it: " + strings.Join(n, ", ") + ")"
				}
			}
			fix := fmt.Sprintf("Nothing was stopped or changed. Run `bothy install --port N` with a free port, or stop what listens on %d yourself.", port)
			if alt := freePort(h, in.Bind, port); alt != 0 {
				fix = fmt.Sprintf("Nothing was stopped or changed. Run `bothy install --port %d` (%d is free), or stop what listens on %d yourself.", alt, alt, port)
			}
			add("port", Fail, fmt.Sprintf("%s:%d is already in use%s", in.Bind, port, who), fix)
		} else {
			add("port", OK, fmt.Sprintf("%s:%d is free", in.Bind, port), "")
		}
	}

	if in.Manifest != nil {
		for _, s := range in.Stack.Meta.Services {
			if _, err := in.Manifest.Lookup(s.ImageKey, s.Own); err != nil {
				add("manifest", Fail, err.Error(), "This manifest is not for a Bivvy install; use the release that matches this binary.")
			}
			var plats []string
			if s.Own {
				plats = in.Manifest.Images[s.ImageKey].Platforms
			} else {
				plats = in.Manifest.ThirdParty[s.ImageKey].Platforms
			}
			if len(plats) > 0 && !contains(plats, "linux/"+h.GOARCH()) {
				add("platform", Fail, fmt.Sprintf("%s is not published for linux/%s", s.ImageKey, h.GOARCH()), "")
			}
		}
	}
	return cs
}

// Failed reports whether any check failed.
func Failed(cs []Check) bool {
	for _, c := range cs {
		if c.Level == Fail {
			return true
		}
	}
	return false
}

func dockerFailure(out string, err error) Check {
	o := strings.ToLower(out + " " + err.Error())
	switch {
	case strings.Contains(o, "wsl integration") || strings.Contains(o, "wsl 2 distro") || strings.Contains(o, "could not be found in this wsl"):
		return Check{"docker", Fail, "Docker Desktop's WSL integration is off for this distribution (docker is only a stub that points at Docker Desktop)",
			"In Docker Desktop: Settings > Resources > WSL integration > enable this distro, then reopen the terminal. Or install Docker Engine inside WSL. bothy does neither for you."}
	case strings.Contains(o, "executable file not found") || strings.Contains(o, "not found") && !strings.Contains(o, "docker.sock"):
		return Check{"docker", Fail, "docker is not installed", "Install Docker Engine (https://docs.docker.com/engine/install/). bothy does not install it for you: that needs root."}
	case strings.Contains(o, "permission denied"):
		return Check{"docker", Fail, "your user cannot use the Docker socket (permission denied)",
			"Run `sudo usermod -aG docker $USER`, then log out and back in (or `newgrp docker` in this shell). bothy does not run sudo itself."}
	default:
		return Check{"docker", Fail, "the Docker daemon is not answering: " + strings.TrimSpace(firstLine(out)),
			"Start it (`sudo systemctl start docker`) and run this again."}
	}
}

// freePort suggests the first unused port from a short list of usual web ports.
func freePort(h Host, bind string, not int) int {
	for _, p := range []int{8080, 8081, 8888, 8000, 3000, 9080} {
		if p != not && !conflict(bind, h.ListenAddrs(p)) {
			return p
		}
	}
	return 0
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// conflict: a listener blocks bind when either is a wildcard or they are equal.
func conflict(bind string, listeners []string) bool {
	wild := func(a string) bool { return a == "0.0.0.0" || a == "::" || a == "" }
	for _, l := range listeners {
		if wild(l) || wild(bind) || l == bind {
			return true
		}
	}
	return false
}

// cmpVersion compares dotted numeric versions ("2026.11.0", "25.0.3"); a
// non-numeric tail (a "-rc1", "+ds") is ignored.
func cmpVersion(a, b string) int {
	pa, pb := vparts(a), vparts(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

func vparts(v string) [3]int {
	v = strings.TrimPrefix(v, "v")
	var out [3]int
	for i, p := range strings.SplitN(v, ".", 3) {
		end := strings.IndexFunc(p, func(r rune) bool { return r < '0' || r > '9' })
		if end < 0 {
			end = len(p)
		}
		out[i], _ = strconv.Atoi(p[:end])
	}
	return out
}
