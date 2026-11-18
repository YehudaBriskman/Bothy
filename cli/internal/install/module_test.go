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

	"github.com/YehudaBriskman/Bothy/cli/internal/stackgen"
)

// ---- a box with a release that also carries node-exporter -------------------

const nodeBody = "# HELP node_memory_MemAvailable_bytes x\nnode_memory_MemAvailable_bytes 1.2e+09\n"

// modRelease writes a manifest+checksums for version: images web a, files c,
// traefik b, node-exporter n.
func modRelease(t *testing.T, version, cm string, a, b, c, n byte) (mp, cp string) {
	t.Helper()
	dir := t.TempDir()
	mb := []byte(fmt.Sprintf(`{"schema":1,"version":%q,"commit":%q,
 "images":{"bothy-web":{"ref":"ghcr.io/o/bothy-web@%s","platforms":["linux/amd64"]},
           "bothy-files":{"ref":"ghcr.io/o/bothy-files@%s","platforms":["linux/amd64"]}},
 "third_party":{"traefik":{"ref":"traefik@%s"},"node-exporter":{"ref":"prom/node-exporter@%s"}},
 "assets":{"cli":"checksums.txt"}}`, version, cm, digest(a), digest(c), digest(b), digest(n)))
	s := sha256.Sum256(mb)
	mp, cp = filepath.Join(dir, "release-manifest.json"), filepath.Join(dir, "checksums.txt")
	_ = os.WriteFile(mp, mb, 0o644)
	_ = os.WriteFile(cp, []byte(hex.EncodeToString(s[:])+"  release-manifest.json\n"), 0o644)
	return
}

type mbox struct {
	*box
	node string // what the node-metrics page serves
	ps   string // compose ps, base services
}

func (b *mbox) registerNode(n byte, pullOK bool) {
	ref := "prom/node-exporter@" + digest(n)
	if pullOK {
		b.h.cmds["docker pull --quiet "+ref] = ref
		b.h.cmds["docker image inspect --format {{json .RepoDigests}} "+ref] = `["` + ref + `"]`
	} else {
		b.h.cmds["docker pull --quiet "+ref] = "!manifest unknown"
	}
	b.h.cmds["docker image inspect --format {{.Id}} "+ref] = "!no such image"
}

const psBase = `{"Service":"bothy-web","State":"running","Health":"healthy"}
{"Service":"traefik","State":"running","Health":"healthy"}
{"Service":"bothy-files","State":"running","Health":"healthy"}
`

func newModBox(t *testing.T) *mbox {
	o := opts(t)
	o.DryRun = false
	mp, cp := modRelease(t, "2026.11.0", commit, 'a', 'b', 'c', '7')
	o.ManifestSrc, o.ChecksumsSrc = mp, cp
	b := &mbox{box: &box{t: t, h: newHost(), o: o, st: mini(t), web: []byte("<html>portal 1</html>"), rev: commit}, node: nodeBody}
	b.o.HTTPGet = func(u string) (int, []byte, error) {
		switch {
		case strings.HasSuffix(u, "/version.json"):
			return 200, []byte(`{"revision":"` + b.rev + `"}`), nil
		case strings.HasSuffix(u, "/-/api/node/metrics"):
			return 200, []byte(b.node), nil
		}
		return 200, b.web, nil
	}
	b.registerImages('a', 'b', 'c', true)
	b.registerNode('7', true)
	b.h.cmds[b.ca(upArgs...)] = ""
	b.h.cmds[b.ca("exec", "-T", "bothy-web", "cat", "/usr/share/nginx/html/index.html")] = string(b.web)
	b.h.cmds[b.ca("ps", "--format", "json")] = psBase
	var out bytes.Buffer
	if err := Install(context.Background(), b.h, b.o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	b.have("ghcr.io/o/bothy-web@"+digest('a'), "traefik@"+digest('b'), "ghcr.io/o/bothy-files@"+digest('c'))
	b.h.cmds[b.ca("ps", "--all", "--format", "json")] = psBase
	return b
}

// nodeUp makes the fake daemon report node-exporter as running (after an add).
func (b *mbox) nodeUp(on bool) {
	ps := psBase
	if on {
		ps += `{"Service":"node-exporter","State":"running","Health":"healthy"}` + "\n"
	}
	b.h.cmds[b.ca("ps", "--format", "json")] = ps
	b.h.cmds[b.ca("ps", "--all", "--format", "json")] = ps
}

func (b *mbox) add(name string, yes bool) (string, error) {
	var out bytes.Buffer
	err := ModuleAdd(context.Background(), b.h, b.o, ModuleChange{Module: name, Yes: yes}, &out)
	return out.String(), err
}

func (b *mbox) remove(name string) (string, error) {
	var out bytes.Buffer
	err := ModuleRemove(context.Background(), b.h, b.o, ModuleChange{Module: name}, &out)
	return out.String(), err
}

func (b *mbox) receipt() *Receipt {
	r, err := readReceipt(b.o.receiptPath())
	if err != nil || r == nil {
		b.t.Fatalf("receipt: %v", err)
	}
	return r
}

func ranAny(h *fakeHost, subs ...string) bool {
	for _, r := range h.ran {
		ok := true
		for _, s := range subs {
			ok = ok && strings.Contains(r, s)
		}
		if ok {
			return true
		}
	}
	return false
}

// ---- add, idempotence, remove ------------------------------------------------

func TestModuleAddThenRemove(t *testing.T) {
	b := newModBox(t)
	if got := b.receipt().Modules; len(got) != 3 || got[0] != "edge" {
		t.Fatalf("install recorded modules %v", got)
	}
	before := b.readFile("compose.yml")
	b.nodeUp(true)
	b.h.ran = nil
	out, err := b.add("node-metrics", false)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	r := b.receipt()
	if r.Status != "complete" || r.Pending != nil || strings.Join(r.Modules, ",") != "edge,files,node-metrics,web" ||
		r.Images["BOTHY_IMAGE_NODE_EXPORTER"] != "prom/node-exporter@"+digest('7') || r.Version != "2026.11.0" {
		t.Fatalf("receipt after add: %+v", r)
	}
	if c := b.readFile("compose.yml"); !strings.Contains(c, "node-exporter:") || strings.Contains(c, "/host") || strings.Contains(c, "path.rootfs") {
		t.Errorf("compose after add:\n%s", c)
	}
	if !strings.Contains(b.readFile("traefik/dynamic/routes.yml"), "/-/api/node/metrics") || !strings.Contains(b.readFile(".env"), "BOTHY_IMAGE_NODE_EXPORTER=prom/node-exporter@"+digest('7')) {
		t.Error("route or image variable missing after add")
	}
	for _, want := range []string{"preflight (for the 64 MiB this adds)", "contains \"node_memory_MemAvailable_bytes\"", "added node-metrics"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	if prev, _ := os.ReadFile(filepath.Join(b.o.DataDir, "previous", "stack", "compose.yml")); string(prev) != before {
		t.Error("the rollback point does not hold the previous compose.yml")
	}
	if ranAny(b.h, "sudo") {
		t.Error("sudo was run")
	}

	// idempotent: the same add again changes nothing and runs no up/pull
	b.h.ran = nil
	out, err = b.add("node-metrics", false)
	if err != nil || !strings.Contains(out, "nothing to do") {
		t.Fatalf("re-run: %v\n%s", err, out)
	}
	if ranAny(b.h, " up ") || ranAny(b.h, " pull ") {
		t.Errorf("an idempotent re-run changed things: %v", b.h.ran)
	}

	// remove it: containers go, data dirs and image stay
	b.nodeUp(false)
	out, err = b.remove("node-metrics")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	r = b.receipt()
	if r.Status != "complete" || strings.Join(r.Modules, ",") != "edge,files,web" || r.Images["BOTHY_IMAGE_NODE_EXPORTER"] != "" {
		t.Fatalf("receipt after remove: %+v", r)
	}
	if c := b.readFile("compose.yml"); strings.Contains(c, "node-exporter") || c != before {
		t.Error("compose after remove is not the original")
	}
	if strings.Contains(b.readFile("traefik/dynamic/routes.yml"), "node/metrics") {
		t.Error("the route survived the remove")
	}
	if ranAny(b.h, "image rm") {
		t.Error("remove deleted an image (a rollback needs it)")
	}
	// removing what is not installed is a no-op
	out, err = b.remove("node-metrics")
	if err != nil || !strings.Contains(out, "nothing to do") {
		t.Errorf("second remove: %v\n%s", err, out)
	}
}

func TestModuleDryRunChangesNothing(t *testing.T) {
	b := newModBox(t)
	b.o.DryRun = true
	before, _ := os.ReadFile(b.o.receiptPath())
	b.h.ran = nil
	out, err := b.add("node-metrics", false)
	if err != nil || !strings.Contains(out, "dry run: nothing was changed") || !strings.Contains(out, "docker pull prom/node-exporter@") {
		t.Fatalf("%v\n%s", err, out)
	}
	after, _ := os.ReadFile(b.o.receiptPath())
	if string(before) != string(after) || ranAny(b.h, " up ") || ranAny(b.h, " pull ") {
		t.Error("dry run changed something")
	}
	if _, err := os.Stat(filepath.Join(b.o.DataDir, "previous")); err == nil {
		t.Error("dry run made a rollback point")
	}
}

// ---- refusals -----------------------------------------------------------------

func TestModuleRefusesWhatDoesNotFit(t *testing.T) {
	b := newModBox(t)
	b.h.mem = 570 // 64 MiB of limits + 512 reserve = 576
	envBefore := b.readFile(".env")
	b.h.ran = nil
	out, err := b.add("node-metrics", false)
	if err != ErrPreflight {
		t.Fatalf("want ErrPreflight, got %v\n%s", err, out)
	}
	if !strings.Contains(out, "570 MiB available, 576 MiB needed (64 MiB of container limits + 512 MiB reserve)") {
		t.Errorf("the numbers are missing:\n%s", out)
	}
	if b.readFile(".env") != envBefore || b.receipt().Status != "complete" || ranAny(b.h, " up ") {
		t.Error("a refused add changed the box")
	}
	b.h.mem = 576
	if out, err = b.add("node-metrics", false); err != nil {
		t.Fatalf("exactly enough memory must fit: %v\n%s", err, out)
	}
}

func TestModuleRefusesCoreAndUnknownAndDependants(t *testing.T) {
	b := newModBox(t)
	if _, err := b.remove("edge"); err == nil || !strings.Contains(err.Error(), "core module") {
		t.Errorf("remove edge: %v", err)
	}
	if _, err := b.add("nope", false); err == nil || !strings.Contains(err.Error(), "have: ") {
		t.Errorf("unknown module: %v", err)
	}
	// dependants: a set where something needs the module that leaves
	ms, _ := Catalogue()
	if d := ms.Dependants([]string{"edge", "web", "files"}, "edge"); len(d) != 2 {
		t.Errorf("dependants of edge: %v", d)
	}
	if d := ms.Dependants([]string{"edge", "web", "files"}, "files"); len(d) != 0 {
		t.Errorf("dependants of files: %v", d)
	}
}

func TestModuleRefusesAnotherRelease(t *testing.T) {
	b := newModBox(t)
	mp, cp := modRelease(t, "2026.11.1", commit2, 'd', 'e', 'f', '6')
	b.o.ManifestSrc, b.o.ChecksumsSrc, b.o.BinaryVersion = mp, cp, "2026.11.1"
	if _, err := b.add("node-metrics", false); err == nil || !strings.Contains(err.Error(), "bothy update") {
		t.Fatalf("a module change on another release must point at update: %v", err)
	}
}

func TestModuleNothingInstalled(t *testing.T) {
	o := opts(t)
	o.DryRun = false
	var out bytes.Buffer
	if err := ModuleAdd(context.Background(), newHost(), o, ModuleChange{Module: "node-metrics"}, &out); err == nil || !strings.Contains(err.Error(), "nothing is installed") {
		t.Fatalf("%v", err)
	}
}

// ---- rollback -----------------------------------------------------------------

func TestModuleAddRollsBackWhenUnhealthy(t *testing.T) {
	cases := map[string]func(b *mbox){
		"the page does not carry the bytes": func(b *mbox) { b.node = "<html>portal</html>" },
		"a container that never becomes healthy": func(b *mbox) {
			b.h.upCmd = b.ca(upArgs...)
			b.h.upFailures = 1
		},
		"a digest the registry lacks": func(b *mbox) { b.registerNode('7', false) },
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			b := newModBox(t)
			b.nodeUp(true)
			oldEnv, oldCompose, oldRoutes := b.readFile(".env"), b.readFile("compose.yml"), b.readFile("traefik/dynamic/routes.yml")
			setup(b)
			out, err := b.add("node-metrics", false)
			if err == nil || !strings.Contains(err.Error(), "rolled back") {
				t.Fatalf("want a rolled-back failure, got %v\n%s", err, out)
			}
			r := b.receipt()
			if r.Status != "complete" || r.Pending != nil || len(r.Modules) != 3 || r.LastModuleError == "" {
				t.Errorf("receipt after rollback: %+v", r)
			}
			if b.readFile(".env") != oldEnv || b.readFile("compose.yml") != oldCompose || b.readFile("traefik/dynamic/routes.yml") != oldRoutes {
				t.Error("the previous generation's files were not restored")
			}
			if !strings.Contains(out, "previous release is up again") {
				t.Errorf("rollback did not prove the old generation:\n%s", out)
			}
		})
	}
}

// ---- interruption --------------------------------------------------------------

// killHost dies (a panic) when a command is run: the process was killed, so no
// rollback code runs.
type killHost struct {
	*fakeHost
	on string
}

func (k killHost) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if name+" "+strings.Join(args, " ") == k.on {
		panic("killed")
	}
	return k.fakeHost.Run(ctx, name, args...)
}

func (b *mbox) killedAdd() {
	b.t.Helper()
	k := killHost{b.h, "docker " + strings.Join(b.o.composeArgs(b.st, upArgs...), " ")}
	defer func() {
		if recover() == nil {
			b.t.Fatal("the host was not killed")
		}
	}()
	_ = ModuleAdd(context.Background(), k, b.o, ModuleChange{Module: "node-metrics"}, &bytes.Buffer{})
}

func TestModuleResumeAfterInterruption(t *testing.T) {
	b := newModBox(t)
	prevEnv := b.readFile(".env")
	b.killedAdd()
	r := b.receipt()
	if r.Status != "in-progress" || r.Pending == nil || r.Pending.Op != "add" || strings.Join(r.Pending.To, ",") != "edge,files,node-metrics,web" {
		t.Fatalf("receipt after a kill: %+v", r)
	}
	// everything else refuses and says what to do
	if err := Update(context.Background(), b.h, b.o, true, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "module change did not finish") {
		t.Errorf("update: %v", err)
	}
	if err := Install(context.Background(), b.h, b.o, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "module change did not finish") {
		t.Errorf("install: %v", err)
	}
	if _, err := b.remove("files"); err == nil || !strings.Contains(err.Error(), "bothy module add node-metrics") {
		t.Errorf("a different change: %v", err)
	}
	// the same verb resumes and finishes, without replacing the rollback point
	b.nodeUp(true)
	out, err := b.add("node-metrics", false)
	if err != nil || !strings.Contains(out, "resuming") {
		t.Fatalf("resume: %v\n%s", err, out)
	}
	r = b.receipt()
	if r.Status != "complete" || r.Pending != nil || len(r.Modules) != 4 {
		t.Fatalf("receipt after resume: %+v", r)
	}
	if prev, _ := os.ReadFile(filepath.Join(b.o.DataDir, "previous", "stack", ".env")); string(prev) != prevEnv {
		t.Error("the resume overwrote the rollback point")
	}
}

func TestModuleRollbackAfterInterruption(t *testing.T) {
	b := newModBox(t)
	oldCompose := b.readFile("compose.yml")
	b.killedAdd()
	var out bytes.Buffer
	if err := ModuleRollback(context.Background(), b.h, b.o, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	r := b.receipt()
	if r.Status != "complete" || r.Pending != nil || len(r.Modules) != 3 || b.readFile("compose.yml") != oldCompose {
		t.Errorf("after rollback: %+v", r)
	}
	if err := ModuleRollback(context.Background(), b.h, b.o, &out); err == nil {
		t.Error("a second rollback must say there is nothing pending")
	}
}

// ---- receipt, schema -------------------------------------------------------------

func TestReceiptRoundTripAndSchemaRefusal(t *testing.T) {
	p := filepath.Join(t.TempDir(), "receipt.json")
	in := &Receipt{Status: "in-progress", Mode: "mini", Modules: []string{"edge", "web"},
		Pending: &PendingOp{Op: "add", Module: "files", From: []string{"edge", "web"}, To: []string{"edge", "files", "web"}}, LastModuleError: "x"}
	if err := writeReceipt(p, in); err != nil {
		t.Fatal(err)
	}
	out, err := readReceipt(p)
	if err != nil || out.Schema != ReceiptSchema || out.Pending == nil || out.Pending.Module != "files" || len(out.Modules) != 2 || out.LastModuleError != "x" {
		t.Fatalf("%+v %v", out, err)
	}
	// a newer receipt is refused, not half read
	if err := os.WriteFile(p, []byte(`{"schema":3,"mode":"mini"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readReceipt(p); err == nil || !strings.Contains(err.Error(), "newer bothy") {
		t.Errorf("schema 3: %v", err)
	}
	// a schema-1 receipt (no modules) means the mode's defaults
	if err := os.WriteFile(p, []byte(`{"schema":1,"mode":"mini","status":"complete"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := readReceipt(p)
	if err != nil {
		t.Fatal(err)
	}
	ms, _ := Catalogue()
	if set, err := receiptSet(ms, r); err != nil || strings.Join(set, ",") != "edge,files,web" {
		t.Errorf("schema-1 set: %v %v", set, err)
	}
}

func TestModuleListShowsCostAndState(t *testing.T) {
	b := newModBox(t)
	var out bytes.Buffer
	if err := ModuleList(b.o, false, &out); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	for _, want := range []string{"node-metrics", "available", "64 Mi", "requires edge", "files", "installed", "core"} {
		if !strings.Contains(s, want) {
			t.Errorf("list lacks %q:\n%s", want, s)
		}
	}
	out.Reset()
	if err := ModuleList(b.o, true, &out); err != nil || !strings.Contains(out.String(), `"memory_mib": 64`) {
		t.Errorf("json: %v\n%s", err, out.String())
	}
}

// ---- update and uninstall after a module -------------------------------------------

func TestUpdateKeepsAddedModulesAndUninstallRemovesThem(t *testing.T) {
	b := newModBox(t)
	b.nodeUp(true)
	if out, err := b.add("node-metrics", false); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	mp, cp := modRelease(t, "2026.11.1", commit2, 'd', 'e', 'f', '6')
	b.o.ManifestSrc, b.o.ChecksumsSrc, b.o.BinaryVersion = mp, cp, "2026.11.1"
	b.registerImages('d', 'e', 'f', true)
	b.registerNode('6', true)
	b.rev = commit2
	var out bytes.Buffer
	if err := Update(context.Background(), b.h, b.o, false, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	r := b.receipt()
	if r.Version != "2026.11.1" || strings.Join(r.Modules, ",") != "edge,files,node-metrics,web" || r.Images["BOTHY_IMAGE_NODE_EXPORTER"] != "prom/node-exporter@"+digest('6') {
		t.Fatalf("receipt after update: %+v", r)
	}
	if !strings.Contains(b.readFile("compose.yml"), "node-exporter:") {
		t.Error("update dropped the added module")
	}
	// uninstall (no purge) removes the module's generated files too
	b.h.cmds[b.ca("down", "--remove-orphans")] = ""
	uo := UninstallOptions{DataDir: b.o.DataDir, ConfigDir: b.o.ConfigDir}
	out.Reset()
	if err := Uninstall(context.Background(), b.h, uo, &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	if _, err := os.Stat(filepath.Join(b.o.stackDir(), "compose.yml")); err == nil {
		t.Error("uninstall left compose.yml")
	}
	if _, err := os.Stat(b.o.receiptPath()); err == nil {
		t.Error("uninstall left the receipt")
	}
}

// ---- the set generator ----------------------------------------------------------------

// What the binary generates at run time from its embedded sources is exactly
// what the repo generates: the embedded copy loses nothing.
func TestRuntimeSetEqualsRepoSet(t *testing.T) {
	ms, err := stackgen.Load(os.DirFS("../../.."))
	if err != nil {
		t.Fatal(err)
	}
	for _, names := range [][]string{nil, {"node-metrics"}, {"edge", "web"}} {
		def := names
		if def == nil {
			def, _ = ms.DefaultSet("mini")
		}
		want, err := stackgen.GenSet(os.DirFS("../../.."), ms, "mini", def)
		if err != nil {
			t.Fatal(err)
		}
		got, err := LoadStackSet("mini", names)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got.Compose, want.Compose) {
			t.Errorf("%v: run-time compose differs from the repo's", names)
		}
		for p, b := range want.Files {
			if !bytes.Equal(got.Files[p], b) {
				t.Errorf("%v: %s differs", names, p)
			}
		}
	}
	// the committed default stack is the default set
	def, _ := LoadStackSet("mini", nil)
	if !bytes.Equal(def.Compose, mini(t).Compose) {
		t.Error("the default set differs from the committed stack/mini")
	}
}

func noHash(s string) string {
	var b strings.Builder
	for _, l := range strings.Split(s, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "#") {
			b.WriteString(l + "\n")
		}
	}
	return b.String()
}

func TestNodeMetricsIsHardened(t *testing.T) {
	st, err := LoadStackSet("mini", []string{"node-metrics"})
	if err != nil {
		t.Fatal(err)
	}
	c := string(st.Compose)
	for _, bad := range []string{"/host", "rootfs", "textfile", "docker.sock", "9100:9100", "privileged"} {
		if strings.Contains(c, bad) {
			t.Errorf("compose has %q", bad)
		}
	}
	if strings.Count(c, "ports:") != 1 {
		t.Error("the module published a host port of its own")
	}
	r := string(st.Files["traefik/dynamic/routes.yml"])
	if !strings.Contains(r, "Path(`/-/api/node/metrics`)") || strings.Contains(noHash(r), "Host(") {
		t.Errorf("routes:\n%s", r)
	}
}
