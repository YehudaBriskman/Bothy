package install

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// PinnedManifestSHA is stamped at release build time
// (-ldflags "-X github.com/YehudaBriskman/Bothy/cli/internal/install.PinnedManifestSHA=<hex>").
// Empty means the checksums.txt check alone applies.
var PinnedManifestSHA = ""

// Options is the whole input of `bothy install`.
type Options struct {
	Mode           string
	Bind           string
	Port           int
	DataDir        string // the install root: stack/, receipt.json
	ConfigDir      string // secrets/ (0700)
	ManifestSrc    string
	ChecksumsSrc   string
	BinaryVersion  string
	DryRun         bool
	AllowDowngrade bool
	// RequireAttestation makes a SKIPPED attestation check fatal (a verdict of
	// "not attested" is fatal either way).
	RequireAttestation bool
	WaitTimeout        int // seconds `compose up --wait` may take; 0 means 180
	previous           *Previous
	pending            *PendingOp // set by the module verbs: recorded in the in-progress receipt
	// HTTPGet is the verify probe; nil means net/http.
	HTTPGet func(url string) (int, []byte, error)
}

// Action is one step of a plan. Done means the machine already is in the state
// the step produces, so a re-run skips it.
type Action struct {
	ID   string
	Desc string
	Done bool
	Run  func(ctx context.Context) error
}

// Receipt is what `bothy uninstall` and a re-run read: what is installed and
// what this tool created.
type Receipt struct {
	Schema         int               `json:"schema"`
	Status         string            `json:"status"` // in-progress | complete
	Mode           string            `json:"mode"`
	Version        string            `json:"version"`
	Commit         string            `json:"commit"`
	ManifestSHA256 string            `json:"manifest_sha256"`
	Bind           string            `json:"bind"`
	Port           int               `json:"port"`
	DataDir        string            `json:"data_dir"`
	ConfigDir      string            `json:"config_dir"`
	Project        string            `json:"project"`
	Images         map[string]string `json:"images"` // compose variable -> digest ref
	Created        []string          `json:"created"`
	LastError      string            `json:"last_error,omitempty"`
	// Modules is the module set this box runs (sorted, core modules included).
	// Absent in a schema-1 receipt: that box runs its mode's default set.
	Modules []string `json:"modules,omitempty"`
	// Pending is set while a `bothy module add|remove` is between its first write
	// and its last: what was being done, and the set before it. A re-run of the
	// same verb resumes; `bothy module rollback` returns to the previous generation.
	Pending         *PendingOp `json:"pending,omitempty"`
	LastModuleError string     `json:"last_module_error,omitempty"`
	// Previous is the release this one replaced (set by `bothy update`): its
	// digests are what a failed update rolls back to, not "whatever is running".
	Previous        *Previous `json:"previous,omitempty"`
	LastUpdateError string    `json:"last_update_error,omitempty"`
	UpdatedAt       string    `json:"updated_at"`
}

// PendingOp is an unfinished module change.
type PendingOp struct {
	Op     string   `json:"op"` // add | remove
	Module string   `json:"module"`
	From   []string `json:"from"` // the set before
	To     []string `json:"to"`   // the set it is moving to
}

// ReceiptSchema is the receipt format this binary reads and writes. Schema 2
// added Modules and Pending. A newer receipt is refused rather than half read:
// an older reader that ignored Modules would "update" a box back to its mode's
// defaults and remove what was added.
const ReceiptSchema = 2

// Previous records the release an update replaced.
type Previous struct {
	Version        string            `json:"version"`
	Commit         string            `json:"commit"`
	ManifestSHA256 string            `json:"manifest_sha256"`
	Images         map[string]string `json:"images"`
}

func (o Options) waitTimeout() string {
	if o.WaitTimeout > 0 {
		return fmt.Sprint(o.WaitTimeout)
	}
	return "180"
}

// ErrPreflight is returned when a preflight check failed (nothing was changed).
var ErrPreflight = errors.New("preflight failed: nothing was changed")

func (o Options) stackDir() string    { return filepath.Join(o.DataDir, "stack") }
func (o Options) receiptPath() string { return filepath.Join(o.DataDir, "receipt.json") }
func (o Options) secretsDir() string  { return filepath.Join(o.ConfigDir, "secrets") }

func readReceipt(path string) (*Receipt, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Receipt
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("%s is not readable (%w); move it aside to start over", path, err)
	}
	if r.Schema > ReceiptSchema {
		return nil, fmt.Errorf("%s is schema %d, written by a newer bothy than this one (understands %d): use that bothy, or this box would lose what the newer receipt records", path, r.Schema, ReceiptSchema)
	}
	return &r, nil
}

func writeReceipt(path string, r *Receipt) error {
	r.Schema = ReceiptSchema
	r.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	b, _ := json.MarshalIndent(r, "", "  ")
	return atomicWrite(path, append(b, '\n'), 0o600)
}

func atomicWrite(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func sameFile(path string, want []byte) bool {
	got, err := os.ReadFile(path)
	return err == nil && bytes.Equal(got, want)
}

// EnvFile renders the stack's .env: the digest refs and the published port.
func EnvFile(st *Stack, o Options, images map[string]string) []byte {
	var b strings.Builder
	b.WriteString("# Written by `bothy install`. Rewritten on every run: do not edit.\n")
	fmt.Fprintf(&b, "BOTHY_BIND=%s\n", o.Bind)
	for _, p := range st.Meta.Publish {
		fmt.Fprintf(&b, "%s=%d\n", p.Env, portOr(o, p.Default))
	}
	keys := sortedKeys(images)
	for _, k := range keys {
		fmt.Fprintf(&b, "%s=%s\n", k, images[k])
	}
	return []byte(b.String())
}

func portOr(o Options, def int) int {
	if o.Port != 0 {
		return o.Port
	}
	return def
}

func (o Options) composeArgs(st *Stack, more ...string) []string {
	a := []string{"compose", "--project-name", st.Meta.Project, "--project-directory", o.stackDir(),
		"--env-file", filepath.Join(o.stackDir(), ".env"), "-f", filepath.Join(o.stackDir(), "compose.yml")}
	return append(a, more...)
}

// Install is `bothy install`. out receives every line a person should see.
func Install(ctx context.Context, h Host, o Options, out io.Writer) error {
	// One writer at a time, taken before the receipt is read. A dry run writes nothing and takes no lock.
	if !o.DryRun {
		release, err := lockInstall(o.DataDir)
		if err != nil {
			return err
		}
		defer release()
	}
	rec, err := readReceipt(o.receiptPath())
	if err != nil {
		return err
	}
	if rec != nil && rec.Pending != nil {
		return pendingError(rec)
	}
	// A box that already has modules added keeps them: install never reduces a
	// box to its mode's defaults (that would remove what `bothy module add` put there).
	var names []string
	if rec != nil && rec.Mode == o.Mode {
		names = rec.Modules
	}
	st, err := LoadStackSet(o.Mode, names)
	if err != nil {
		return err
	}
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	p("bothy install: mode %s (%s), Compose runtime, version %s", o.Mode, st.Meta.Title, o.BinaryVersion)

	// 1. the release manifest, verified before anything else is believed.
	mb, err := Fetch(o.ManifestSrc)
	if err != nil {
		return fmt.Errorf("fetch release manifest: %w", err)
	}
	cb, err := Fetch(o.ChecksumsSrc)
	if err != nil {
		return fmt.Errorf("fetch checksums.txt: %w", err)
	}
	m, msha, err := VerifyManifest(mb, cb, o.BinaryVersion, PinnedManifestSHA)
	if err != nil {
		return err
	}
	p("manifest: release-manifest.json sha256 %s matches checksums.txt; version %s commit %s", msha[:12], m.Version, m.Commit[:12])
	if err := checkAttestation(ctx, h, o.ChecksumsSrc, cb, out, o.RequireAttestation); err != nil {
		return err
	}

	if rec != nil && rec.Mode != o.Mode {
		return fmt.Errorf("this box has a %q install; changing mode is not supported by `bothy install` yet", rec.Mode)
	}
	if rec != nil && rec.Version != "" && cmpVersion(m.Version, rec.Version) < 0 && !o.AllowDowngrade {
		return fmt.Errorf("installed version %s is newer than %s: refusing a downgrade (pass --allow-downgrade to force it)", rec.Version, m.Version)
	}

	// 2. preflight.
	// Our own port: a complete install, or a half one whose containers are still
	// up (an interrupted run), is not a conflict with itself.
	sameAddr := rec != nil && rec.Bind == o.Bind && rec.Port == portOr(o, st.Meta.Publish[0].Default)
	pf := Preflight(ctx, h, PreflightIn{Stack: st, Manifest: m, Bind: o.Bind, Port: o.Port, DataDir: nearest(o.DataDir),
		RealDataDir: o.DataDir, ConfigDir: o.ConfigDir, StackDir: o.stackDir(),
		OwnPortsOK: sameAddr && (rec.Status == "complete" || ownRunning(ctx, h, o, st))})
	p("\npreflight:")
	for _, c := range pf {
		p("  %-4s %-10s %s", c.Level, c.ID, c.Msg)
		if c.Fix != "" && c.Level != OK {
			p("       fix: %s", c.Fix)
		}
	}
	if Failed(pf) {
		return ErrPreflight
	}

	// 3. the plan.
	images := map[string]string{}
	for _, s := range st.Meta.Services {
		ref, err := m.Lookup(s.ImageKey, s.Own)
		if err != nil {
			return err
		}
		images[s.ImageVar] = ref
	}
	acts := buildPlan(h, o, st, m, msha, rec, images)
	pending := 0
	p("\nplan (%s; needs root: nothing; sudo is never run):", map[bool]string{true: "dry run", false: "apply"}[o.DryRun])
	for _, a := range acts {
		mark := "do   "
		if a.Done {
			mark = "skip "
		} else {
			pending++
		}
		p("  %s %-9s %s", mark, a.ID, a.Desc)
	}
	if pending == 0 {
		p("\nnothing to do: this box already matches release %s.", m.Version)
		if o.DryRun {
			return nil
		}
		return verify(ctx, h, o, st, m, out)
	}
	if o.DryRun {
		p("\ndry run: nothing was changed.")
		return nil
	}

	// 4. apply, in order; stop at the first failure.
	p("")
	firstInstall := rec == nil || rec.Status != "complete"
	started := false
	for _, a := range acts {
		if a.Done {
			continue
		}
		t0 := time.Now()
		p("-> %s", a.Desc)
		if a.ID == "up" {
			started = true
		}
		if err := a.Run(ctx); err != nil {
			interrupted := ctx.Err() != nil
			if interrupted {
				p("   INTERRUPTED after %s (Ctrl-C or SIGTERM)", time.Since(t0).Round(time.Millisecond))
				err = fmt.Errorf("interrupted: %w", ctx.Err())
			} else {
				p("   FAILED after %s: %s", time.Since(t0).Round(time.Millisecond), withHint(err.Error()))
			}
			recordFailure(o, err)
			if started && firstInstall {
				// The run's own context may be cancelled (Ctrl-C): the cleanup must still run.
				p("   rolling back what this run started: docker compose down (data and files are kept)")
				cctx, ccancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
				if out, derr := h.Run(cctx, "docker", o.composeArgs(st, "down", "--remove-orphans")...); derr != nil {
					p("   compose down also failed: %v: %s", derr, firstLine(string(out)))
				}
				ccancel()
			}
			p("\nThe install is incomplete. Run `bothy install` again to resume (finished steps are skipped),")
			p("or `bothy uninstall` to remove what exists.")
			return fmt.Errorf("%s: %w", a.ID, err)
		}
		p("   ok (%s)", time.Since(t0).Round(time.Millisecond))
	}
	if err := verify(ctx, h, o, st, m, out); err != nil {
		recordFailure(o, err)
		if firstInstall {
			p("   rolling back what this run started: docker compose down")
			_, _ = h.Run(ctx, "docker", o.composeArgs(st, "down", "--remove-orphans")...)
		}
		return err
	}
	r2, _ := readReceipt(o.receiptPath())
	if r2 != nil {
		r2.Status, r2.LastError = "complete", ""
		if err := writeReceipt(o.receiptPath(), r2); err != nil {
			return err
		}
	}
	host := o.Bind
	if host == "0.0.0.0" {
		host = "<this machine's address>"
	}
	p("\nBivvy is up: http://%s:%d/  (release %s)", host, portOr(o, st.Meta.Publish[0].Default), m.Version)
	return nil
}

func recordFailure(o Options, err error) {
	if r, _ := readReceipt(o.receiptPath()); r != nil {
		r.LastError = err.Error()
		_ = writeReceipt(o.receiptPath(), r)
	}
}

// nearest returns dir, or its closest existing parent, for measuring disk.
func nearest(dir string) string {
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Stat(d); err == nil || d == filepath.Dir(d) {
			return d
		}
	}
}

func buildPlan(h Host, o Options, st *Stack, m *Manifest, msha string, rec *Receipt, images map[string]string) []Action {
	var acts []Action
	ctxRun := func(name string, args ...string) func(context.Context) error {
		return func(ctx context.Context) error {
			out, err := h.Run(ctx, name, args...)
			if err != nil {
				return fmt.Errorf("%s %s: %v\n%s", name, strings.Join(args[:min(len(args), 2)], " "), err, strings.TrimSpace(string(out)))
			}
			return nil
		}
	}
	isDir := func(p string) bool { s, err := os.Stat(p); return err == nil && s.IsDir() }

	// dirs
	var dirs []string
	dirs = append(dirs, o.DataDir, o.stackDir())
	for _, d := range st.Meta.Mkdirs {
		dirs = append(dirs, filepath.Join(o.stackDir(), filepath.FromSlash(d)))
	}
	missing := []string{}
	for _, d := range dirs {
		if !isDir(d) {
			missing = append(missing, d)
		}
	}
	acts = append(acts, Action{"dirs", fmt.Sprintf("create %d directories under %s (0755; mkdir as your user so Docker never creates them as root)", len(dirs), o.DataDir), len(missing) == 0,
		func(context.Context) error {
			for _, d := range dirs {
				if err := os.MkdirAll(d, 0o755); err != nil {
					return err
				}
			}
			return nil
		}})

	// secrets
	key := filepath.Join(o.secretsDir(), "master.key")
	ks, kerr := os.Stat(key)
	keyOK := kerr == nil && ks.Size() > 0 // an empty file is an interrupted write: regenerate
	acts = append(acts, Action{"secrets", fmt.Sprintf("generate %s (32 random bytes, 0600, in a 0700 directory; never printed, never in the binary)", key), keyOK,
		func(context.Context) error {
			if err := os.MkdirAll(o.secretsDir(), 0o700); err != nil {
				return err
			}
			if err := os.Chmod(o.ConfigDir, 0o700); err != nil {
				return err
			}
			if err := os.Chmod(o.secretsDir(), 0o700); err != nil {
				return err
			}
			b := make([]byte, 32)
			if _, err := rand.Read(b); err != nil {
				return err
			}
			// Written whole to a temp name, then renamed: an interruption never leaves a half key.
			tmp := key + ".tmp"
			_ = os.Remove(tmp)
			f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return err
			}
			if _, err = f.WriteString(hex.EncodeToString(b) + "\n"); err == nil {
				err = f.Close()
			} else {
				_ = f.Close()
			}
			if err != nil {
				_ = os.Remove(tmp)
				return err
			}
			if kerr == nil { // only an empty file can be in the way: a non-empty key never gets here
				_ = os.Remove(key)
			}
			return os.Rename(tmp, key)
		}})

	// receipt (in-progress marker, written before anything is started)
	want := &Receipt{Status: "in-progress", Mode: o.Mode, Version: m.Version, Commit: m.Commit, ManifestSHA256: msha,
		Bind: o.Bind, Port: portOr(o, st.Meta.Publish[0].Default), DataDir: o.DataDir, ConfigDir: o.ConfigDir,
		Project: st.Meta.Project, Images: images, Previous: o.previous, Modules: moduleNames(st), Pending: o.pending}
	recDone := rec != nil && rec.Status == "complete" && rec.Version == m.Version && rec.ManifestSHA256 == msha &&
		rec.Bind == want.Bind && rec.Port == want.Port && rec.Pending == nil && sameStrings(rec.Modules, want.Modules)
	acts = append(acts, Action{"receipt", fmt.Sprintf("record the install in %s (what was created, which release; uninstall reads it)", o.receiptPath()), recDone,
		func(context.Context) error {
			if err := os.MkdirAll(o.DataDir, 0o755); err != nil {
				return err
			}
			want.Created = []string{o.stackDir(), key}
			if rec != nil {
				want.Created = rec.Created
			}
			return writeReceipt(o.receiptPath(), want)
		}})

	// stack files
	envB := EnvFile(st, o, images)
	files := map[string][]byte{"compose.yml": st.Compose, ".env": envB}
	for n, b := range st.Files {
		files[n] = b
	}
	names := sortedKeys(files)
	var stale []string
	for _, n := range names {
		if !sameFile(filepath.Join(o.stackDir(), filepath.FromSlash(n)), files[n]) {
			stale = append(stale, n)
		}
	}
	acts = append(acts, Action{"files", fmt.Sprintf("write %s (embedded stack for %s; .env carries the digest refs)", strings.Join(names, ", "), o.Mode), len(stale) == 0,
		func(context.Context) error {
			for _, n := range names {
				perm := os.FileMode(0o644)
				if n == ".env" {
					perm = 0o600
				}
				dst := filepath.Join(o.stackDir(), filepath.FromSlash(n))
				if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
					return err
				}
				if err := atomicWrite(dst, files[n], perm); err != nil {
					return err
				}
			}
			return nil
		}})

	// images, by digest, one pull each
	var vars []string
	for v := range images {
		vars = append(vars, v)
	}
	sort.Strings(vars)
	for _, v := range vars {
		ref := images[v]
		have := false
		if o.DryRun || true {
			out, err := h.Run(context.Background(), "docker", "image", "inspect", "--format", "{{.Id}}", ref)
			have = err == nil && strings.TrimSpace(string(out)) != ""
		}
		wantDigest := ref[strings.Index(ref, "@")+1:]
		acts = append(acts, Action{"pull", "docker pull " + ref, have,
			func(ctx context.Context) error {
				if out, err := h.Run(ctx, "docker", "pull", "--quiet", ref); err != nil {
					return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
				}
				out, err := h.Run(ctx, "docker", "image", "inspect", "--format", "{{json .RepoDigests}}", ref)
				if err != nil || !strings.Contains(string(out), wantDigest) {
					return fmt.Errorf("pulled image does not carry the digest %s", wantDigest)
				}
				return nil
			}})
	}

	// up
	upDone := rec != nil && rec.Status == "complete" && len(stale) == 0 && recDone && servicesHealthy(h, o, st)
	acts = append(acts, Action{"up", "docker compose up -d --wait --pull never  (project " + st.Meta.Project + ", stack " + o.stackDir() + ")", upDone,
		func(ctx context.Context) error {
			return ctxRun("docker", o.composeArgs(st, "up", "-d", "--wait", "--wait-timeout", o.waitTimeout(), "--pull", "never", "--remove-orphans")...)(ctx)
		}})
	acts = append(acts, Action{"verify", "fetch the portal through the edge and compare its bytes with the container's, and /version.json with the release commit", upDone, nil})
	// The last action has no Run: Install runs verify itself after the loop.
	for i := range acts {
		if acts[i].Run == nil {
			acts[i].Run = func(context.Context) error { return nil }
		}
	}
	return acts
}

func servicesHealthy(h Host, o Options, st *Stack) bool {
	out, err := h.Run(context.Background(), "docker", o.composeArgs(st, "ps", "--format", "json")...)
	if err != nil {
		return false
	}
	running := map[string]bool{}
	for _, ln := range bytes.Split(out, []byte("\n")) {
		ln = bytes.TrimSpace(ln)
		if len(ln) == 0 || ln[0] != '{' {
			continue
		}
		var c struct{ Service, State, Health string }
		if json.Unmarshal(ln, &c) == nil && c.State == "running" && (c.Health == "" || c.Health == "healthy") {
			running[c.Service] = true
		}
	}
	for _, s := range st.Meta.Services {
		if !running[s.Name] {
			return false
		}
	}
	return true
}

// verify proves bytes, not a status code. The edge's catch-all answers 200 for
// anything, so: (1) /version.json must name the release commit; (2) each
// declared path must be byte-identical to the file inside the service that
// owns it.
func verify(ctx context.Context, h Host, o Options, st *Stack, m *Manifest, out io.Writer) error {
	get := o.HTTPGet
	if get == nil {
		// Probing this machine's own address must never go through HTTP(S)_PROXY.
		c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
		get = func(u string) (int, []byte, error) {
			r, err := c.Get(u)
			if err != nil {
				return 0, nil, err
			}
			defer r.Body.Close()
			b, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
			return r.StatusCode, b, err
		}
	}
	probe := o.Bind
	if probe == "0.0.0.0" || probe == "" {
		probe = "127.0.0.1"
	}
	base := fmt.Sprintf("http://%s:%d", probe, portOr(o, st.Meta.Publish[0].Default))
	fetchRetry := func(path string) ([]byte, error) {
		var last error
		for i := 0; i < 30; i++ {
			code, b, err := get(base + path)
			if err == nil && code == 200 {
				return b, nil
			}
			if err == nil {
				err = fmt.Errorf("HTTP %d", code)
			}
			last = err
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Second):
			}
		}
		return nil, fmt.Errorf("GET %s%s: %v", base, path, last)
	}
	v := st.Meta.Verify
	b, err := fetchRetry(v.VersionPath)
	if err != nil {
		return err
	}
	var kv map[string]any
	if err := json.Unmarshal(b, &kv); err != nil {
		return fmt.Errorf("%s did not return JSON (the catch-all answering for an unrouted path?): %.60q", v.VersionPath, b)
	}
	if got, _ := kv[v.VersionKey].(string); got != m.Commit {
		return fmt.Errorf("%s says %s=%q, the release commit is %s", v.VersionPath, v.VersionKey, got, m.Commit)
	}
	fmt.Fprintf(out, "verify: %s%s reports %s=%s\n", base, v.VersionPath, v.VersionKey, m.Commit[:12])
	for _, br := range v.Bytes {
		served, err := fetchRetry(br.Path)
		if err != nil {
			return err
		}
		inside, err := h.Run(ctx, "docker", o.composeArgs(st, "exec", "-T", br.Service, "cat", br.File)...)
		if err != nil {
			return fmt.Errorf("read %s in %s: %v", br.File, br.Service, err)
		}
		if !bytes.Equal(served, inside) {
			return fmt.Errorf("GET %s%s (%d bytes) differs from %s in %s (%d bytes)", base, br.Path, len(served), br.File, br.Service, len(inside))
		}
		fmt.Fprintf(out, "verify: GET %s is byte-identical to %s in %s (%d bytes)\n", br.Path, br.File, br.Service, len(served))
	}
	for _, hr := range v.HTTP {
		served, err := fetchRetry(hr.Path)
		if err != nil {
			return err
		}
		if !bytes.Contains(served, []byte(hr.Contains)) {
			return fmt.Errorf("GET %s%s (%d bytes) does not contain %q (the catch-all answering for an unrouted path?)", base, hr.Path, len(served), hr.Contains)
		}
		fmt.Fprintf(out, "verify: GET %s contains %q (%d bytes)\n", hr.Path, hr.Contains, len(served))
	}
	return nil
}
