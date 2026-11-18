package install

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/stackgen"
)

// `bothy module list|add|remove|rollback` changes the module set of an
// INSTALLED box (Compose runtime). A module is data (stack/modes.yml); this file
// names none. Like install and update it is not reachable from the MCP server.
//
// A module change never changes the release: the box keeps its images, and a new
// module's images come from the manifest of the SAME release (a different release
// is `bothy update`). It runs the update's machinery: a rollback point holding
// the previous generation, apply in steps, bytes verified, and a failure puts the
// previous generation back and proves it.

func moduleNames(st *Stack) []string {
	out := make([]string, 0, len(st.Meta.Modules))
	for _, m := range st.Meta.Modules {
		out = append(out, m.Name)
	}
	sort.Strings(out)
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func pendingError(rec *Receipt) error {
	pd := rec.Pending
	return fmt.Errorf("a module change did not finish (%s %s): run `bothy module %s %s` again to resume it, or `bothy module rollback` to return to the previous generation", pd.Op, pd.Module, pd.Op, pd.Module)
}

// uninstallStack is the stack uninstall removes: every module the receipt names,
// plus the set before an unfinished module change. A module this binary no longer
// knows is skipped (uninstall must still work); compose down uses the compose
// file on disk anyway.
func uninstallStack(rec *Receipt) (*Stack, error) {
	ms, err := Catalogue()
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var names []string
	add := func(l []string) {
		for _, n := range l {
			if _, ok := ms.Modules[n]; ok && !seen[n] {
				seen[n] = true
				names = append(names, n)
			}
		}
	}
	add(rec.Modules)
	if rec.Pending != nil {
		add(rec.Pending.From)
		add(rec.Pending.To)
	}
	if len(names) == 0 {
		names = nil
	}
	return LoadStackSet(rec.Mode, names)
}

// receiptSet is the module set a receipt records (a schema-1 receipt: the mode's defaults).
func receiptSet(ms *stackgen.Modes, rec *Receipt) ([]string, error) {
	if len(rec.Modules) > 0 {
		return ms.Closure(rec.Modules)
	}
	return ms.DefaultSet(rec.Mode)
}

// ModuleRow is one line of `bothy module list`.
type ModuleRow struct {
	Name        string   `json:"name"`
	Installed   bool     `json:"installed"`
	Core        bool     `json:"core,omitempty"`
	Description string   `json:"description"`
	MemMiB      int      `json:"memory_mib"`
	Requires    []string `json:"requires"`
	Provides    []string `json:"provides"`
	Services    []string `json:"services"`
	Dirs        []string `json:"dirs,omitempty"`
	DefaultIn   []string `json:"default_in_modes"`
}

// ModuleList prints what this binary offers and what the box runs. Read-only.
func ModuleList(o Options, asJSON bool, out io.Writer) error {
	ms, err := Catalogue()
	if err != nil {
		return err
	}
	rec, err := readReceipt(o.receiptPath())
	if err != nil {
		return err
	}
	mode := o.Mode
	have := map[string]bool{}
	if rec != nil {
		mode = rec.Mode
		set, err := receiptSet(ms, rec)
		if err != nil {
			return err
		}
		for _, n := range set {
			have[n] = true
		}
	}
	var rows []ModuleRow
	for _, n := range ms.ModuleNames() {
		mod := ms.Modules[n]
		row := ModuleRow{Name: n, Installed: have[n], Core: mod.Core, Description: mod.Description, MemMiB: mod.MemoryMiB,
			Requires: nzs(mod.Requires), Provides: nzs(append([]string{n}, mod.Provides...)), Services: mod.Services, DefaultIn: nzs(mod.Modes)}
		if st, err := LoadStackSet(mode, []string{n}); err == nil {
			for _, mm := range st.Meta.Modules {
				if mm.Name == n {
					row.Dirs = mm.Mkdirs
				}
			}
		}
		rows = append(rows, row)
	}
	if asJSON {
		b, _ := json.MarshalIndent(map[string]any{"mode": mode, "installed": rec != nil, "modules": rows}, "", "  ")
		fmt.Fprintf(out, "%s\n", b)
		return nil
	}
	if rec == nil {
		fmt.Fprintf(out, "nothing is installed here (no receipt at %s): showing what this binary offers for mode %s\n\n", o.receiptPath(), mode)
	} else {
		fmt.Fprintf(out, "mode %s, release %s, %d modules installed\n\n", rec.Mode, rec.Version, len(have))
	}
	fmt.Fprintf(out, "%-14s %-10s %8s  %s\n", "MODULE", "STATE", "MEMORY", "NEEDS / WHAT IT IS")
	for _, r := range rows {
		state := "available"
		switch {
		case r.Installed && r.Core:
			state = "core"
		case r.Installed:
			state = "installed"
		case rec == nil:
			state = "-"
		}
		needs := "-"
		if len(r.Requires) > 0 {
			needs = "requires " + strings.Join(r.Requires, ", ")
		}
		fmt.Fprintf(out, "%-14s %-10s %5d Mi  %s; %s\n", r.Name, state, r.MemMiB, needs, r.Description)
		if len(r.Dirs) > 0 {
			fmt.Fprintf(out, "%-14s %-10s %8s  directories under the install root: %s\n", "", "", "", strings.Join(r.Dirs, ", "))
		}
	}
	fmt.Fprintln(out, "\nMemory is the sum of the module's container limits (what the budget gate counts).")
	return nil
}

func nzs(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ModuleChange is the input of add and remove.
type ModuleChange struct {
	Module string
	// Yes accepts the extra modules an add pulls in without asking.
	Yes bool
	In  io.Reader
}

// ModuleAdd is `bothy module add NAME`.
func ModuleAdd(ctx context.Context, h Host, o Options, c ModuleChange, out io.Writer) error {
	return moduleChange(ctx, h, o, "add", c, out)
}

// ModuleRemove is `bothy module remove NAME`.
func ModuleRemove(ctx context.Context, h Host, o Options, c ModuleChange, out io.Writer) error {
	return moduleChange(ctx, h, o, "remove", c, out)
}

func moduleChange(ctx context.Context, h Host, o Options, op string, c ModuleChange, out io.Writer) error {
	if err := RefuseRoot(h); err != nil {
		return err
	}
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	if !o.DryRun {
		release, lerr := lockInstall(o.DataDir)
		if lerr != nil {
			return lerr
		}
		defer release()
	}
	rec, err := readReceipt(o.receiptPath())
	if err != nil {
		return err
	}
	if rec == nil {
		return fmt.Errorf("nothing is installed here (no receipt at %s): run `bothy install`", o.receiptPath())
	}
	if rec.DataDir != o.DataDir {
		return fmt.Errorf("the receipt says the install root is %s, not %s", rec.DataDir, o.DataDir)
	}
	o.Mode, o.Bind, o.Port, o.ConfigDir = rec.Mode, rec.Bind, rec.Port, rec.ConfigDir
	ms, err := Catalogue()
	if err != nil {
		return err
	}
	if _, ok := ms.Modules[c.Module]; !ok {
		return fmt.Errorf("no module %q (have: %s)", c.Module, strings.Join(ms.ModuleNames(), ", "))
	}
	prevDir := filepath.Join(o.DataDir, "previous")
	resume := false
	var from, to []string
	if rec.Pending != nil {
		if rec.Pending.Op != op || rec.Pending.Module != c.Module {
			return pendingError(rec)
		}
		resume, from, to = true, rec.Pending.From, rec.Pending.To
		p("bothy module %s %s: resuming the change that did not finish", op, c.Module)
	} else {
		if rec.Status != "complete" {
			return fmt.Errorf("the last install did not finish (receipt says %q): run `bothy install` to resume it first", rec.Status)
		}
		if from, err = receiptSet(ms, rec); err != nil {
			return fmt.Errorf("the receipt names a module this binary does not know: %w", err)
		}
		installed := contains(from, c.Module)
		switch op {
		case "add":
			if installed {
				return alreadyDone(ctx, h, o, rec, from, c.Module, "installed", out)
			}
			if to, err = ms.Closure(append(append([]string{}, from...), c.Module)); err != nil {
				return err
			}
			if extra := minus(to, append(append([]string{}, from...), c.Module)); len(extra) > 0 {
				mem := 0
				for _, e := range extra {
					mem += ms.Modules[e].MemoryMiB
				}
				p("%s requires %s (+%d MiB). They would be added too.", c.Module, strings.Join(extra, ", "), mem)
				if !c.Yes && !o.DryRun {
					p("Add them too? [y/N]")
					line, _ := bufio.NewReader(orEmpty(c.In)).ReadString('\n')
					if l := strings.ToLower(strings.TrimSpace(line)); l != "y" && l != "yes" {
						return fmt.Errorf("not confirmed: nothing was changed (pass --yes to accept the required modules)")
					}
				}
			}
		case "remove":
			if !installed {
				return alreadyDone(ctx, h, o, rec, from, c.Module, "not installed", out)
			}
			if ms.Modules[c.Module].Core {
				return fmt.Errorf("%s is a core module: every set has it and it cannot be removed", c.Module)
			}
			if deps := ms.Dependants(from, c.Module); len(deps) > 0 {
				return fmt.Errorf("cannot remove %s: %s needs it (remove %s first)", c.Module, strings.Join(deps, ", "), strings.Join(deps, ", "))
			}
			for _, n := range from {
				if n != c.Module {
					to = append(to, n)
				}
			}
		}
	}
	oldSt, err := LoadStackSet(o.Mode, from)
	if err != nil {
		return err
	}
	newSt, err := LoadStackSet(o.Mode, to)
	if err != nil {
		return err
	}
	p("bothy module %s %s: %s -> %s (Compose runtime, release %s)", op, c.Module, strings.Join(from, ","), strings.Join(to, ","), rec.Version)

	// the release: an add takes the new images from the manifest of THIS release.
	m := &Manifest{Version: rec.Version, Commit: rec.Commit}
	msha := rec.ManifestSHA256
	images := map[string]string{}
	for _, s := range newSt.Meta.Services {
		if ref, ok := rec.Images[s.ImageVar]; ok {
			images[s.ImageVar] = ref
		}
	}
	var fresh []stackgen.Service
	for _, s := range newSt.Meta.Services {
		if _, ok := images[s.ImageVar]; !ok {
			fresh = append(fresh, s)
		}
	}
	if len(fresh) > 0 {
		mb, err := Fetch(o.ManifestSrc)
		if err != nil {
			return fmt.Errorf("fetch release manifest: %w", err)
		}
		cb, err := Fetch(o.ChecksumsSrc)
		if err != nil {
			return fmt.Errorf("fetch checksums.txt: %w", err)
		}
		var mm *Manifest
		if mm, msha, err = VerifyManifest(mb, cb, o.BinaryVersion, PinnedManifestSHA); err != nil {
			return err
		}
		if mm.Version != rec.Version || msha != rec.ManifestSHA256 {
			return fmt.Errorf("this binary is release %s but the box runs %s: a module change never changes the release. Run `bothy update` first", mm.Version, rec.Version)
		}
		if err := checkAttestation(ctx, h, o.ChecksumsSrc, cb, out, o.RequireAttestation); err != nil {
			return err
		}
		m = mm
		for _, s := range fresh {
			ref, err := m.Lookup(s.ImageKey, s.Own)
			if err != nil {
				return err
			}
			images[s.ImageVar] = ref
		}
	}

	// preflight: the budget and the host, for what is ADDED (the running stack is
	// already out of MemAvailable)
	if op == "add" && !resume {
		delta := &Stack{Meta: stackgen.Meta{ReserveMiB: newSt.Meta.ReserveMiB, Services: fresh, Publish: nil}}
		var pm *Manifest
		if len(fresh) > 0 {
			pm = m
		}
		pf := Preflight(ctx, h, PreflightIn{Stack: delta, Manifest: pm, Bind: o.Bind, Port: o.Port, DataDir: nearest(o.DataDir), OwnPortsOK: true})
		pf = append(pf, volumeChecks(o, oldSt, newSt)...)
		p("\npreflight (for the %d MiB this adds):", sumMem(fresh))
		for _, c := range pf {
			p("  %-4s %-10s %s", c.Level, c.ID, c.Msg)
			if c.Fix != "" && c.Level != OK {
				p("       fix: %s", c.Fix)
			}
		}
		if Failed(pf) {
			return ErrPreflight
		}
	}

	o.previous = rec.Previous
	o.pending = &PendingOp{Op: op, Module: c.Module, From: from, To: to}
	acts := buildPlan(h, o, newSt, m, msha, rec, images)
	acts = withPrune(acts, o, oldSt, newSt)
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
	if o.DryRun {
		p("\ndry run: nothing was changed.")
		return nil
	}

	// the rollback point: the generation before the change. On a resume it is
	// already there and must not be overwritten with a half-changed one.
	if resume {
		if _, err := os.Stat(filepath.Join(prevDir, "receipt.json")); err != nil {
			return fmt.Errorf("cannot resume: the rollback point %s is gone", prevDir)
		}
	} else {
		p("\n-> keep the current generation for rollback in %s", prevDir)
		if err := saveRollbackPoint(o, oldSt, rec, prevDir); err != nil {
			return fmt.Errorf("cannot save the rollback point (nothing was changed): %w", err)
		}
	}
	prevRec, err := readReceipt(filepath.Join(prevDir, "receipt.json"))
	if err != nil || prevRec == nil {
		return fmt.Errorf("cannot read the rollback point: %v", err)
	}
	fail := func(step string, cause error) error {
		recordFailure(o, cause)
		p("\nmodule %s %s FAILED at %s: %v", op, c.Module, step, cause)
		p("rolling back to the previous generation (%s)", strings.Join(prevRec.Modules, ","))
		if rerr := rollbackModule(context.WithoutCancel(ctx), h, o, oldSt, newSt, prevRec, prevDir, cause, out); rerr != nil {
			p("\nROLLBACK FAILED: %v", rerr)
			p("The previous generation's files are kept in %s; the receipt still says a module change is pending.", prevDir)
			return fmt.Errorf("%s: %v; rollback failed: %w", step, cause, rerr)
		}
		return fmt.Errorf("module %s %s failed at %s and was rolled back: %w", op, c.Module, step, errShort{cause})
	}
	for _, a := range acts {
		if a.Done {
			continue
		}
		t0 := time.Now()
		p("-> %s", a.Desc)
		if err := a.Run(ctx); err != nil {
			p("   FAILED after %s", time.Since(t0).Round(time.Millisecond))
			return fail(a.ID, err)
		}
		p("   ok (%s)", time.Since(t0).Round(time.Millisecond))
	}
	if err := verify(ctx, h, o, newSt, m, out); err != nil {
		return fail("verify", err)
	}
	if op == "remove" {
		if err := assertGone(ctx, h, o, newSt, removedServices(oldSt, newSt)); err != nil {
			return fail("verify", err)
		}
	}
	r2, _ := readReceipt(o.receiptPath())
	if r2 == nil {
		return fmt.Errorf("the receipt disappeared")
	}
	r2.Status, r2.LastError, r2.LastModuleError, r2.Pending, r2.Modules = "complete", "", "", nil, to
	if err := writeReceipt(o.receiptPath(), r2); err != nil {
		return err
	}
	switch op {
	case "add":
		p("\nadded %s: %d MiB of limits, health verified by bytes. The release is unchanged (%s).", c.Module, sumMem(fresh), rec.Version)
	default:
		p("\nremoved %s. Its containers are gone; its data directories (%s) and its image are kept.", c.Module, strings.Join(modDirs(oldSt, c.Module), ", "))
	}
	return nil
}

func orEmpty(r io.Reader) io.Reader {
	if r == nil {
		return strings.NewReader("")
	}
	return r
}

func sumMem(ss []stackgen.Service) int {
	n := 0
	for _, s := range ss {
		n += s.MemMiB
	}
	return n
}

// minus returns the members of a that are not in b.
func minus(a, b []string) []string {
	var out []string
	for _, x := range a {
		if !contains(b, x) {
			out = append(out, x)
		}
	}
	return out
}

func modDirs(st *Stack, name string) []string {
	for _, m := range st.Meta.Modules {
		if m.Name == name {
			return m.Mkdirs
		}
	}
	return nil
}

func removedServices(oldSt, newSt *Stack) []string {
	keep := map[string]bool{}
	for _, s := range newSt.Meta.Services {
		keep[s.Name] = true
	}
	var out []string
	for _, s := range oldSt.Meta.Services {
		if !keep[s.Name] {
			out = append(out, s.Name)
		}
	}
	return out
}

// alreadyDone is the idempotent re-run: the box is already in the asked state;
// prove it still is, by bytes, without touching anything or the network.
func alreadyDone(ctx context.Context, h Host, o Options, rec *Receipt, set []string, name, state string, out io.Writer) error {
	fmt.Fprintf(out, "nothing to do: %s is already %s on this box.\n", name, state)
	st, err := LoadStackSet(o.Mode, set)
	if err != nil {
		return err
	}
	if o.DryRun {
		return nil
	}
	return verify(ctx, h, o, st, &Manifest{Commit: rec.Commit}, out)
}

// volumeChecks: the directories a module binds must be creatable as directories.
func volumeChecks(o Options, oldSt, newSt *Stack) []Check {
	have := map[string]bool{}
	for _, d := range oldSt.Meta.Mkdirs {
		have[d] = true
	}
	var cs []Check
	bad := 0
	for _, d := range newSt.Meta.Mkdirs {
		if have[d] {
			continue
		}
		path := filepath.Join(o.stackDir(), filepath.FromSlash(d))
		if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
			bad++
			cs = append(cs, Check{"volumes", Fail, path + " exists and is not a directory", "Move it aside; the module needs a directory there."})
		}
	}
	if bad == 0 {
		cs = append(cs, Check{"volumes", OK, "every directory the module binds can be created", ""})
	}
	return cs
}

// withPrune inserts the step that deletes generated files the new set no longer
// has (a removed module's own files), before `up`.
func withPrune(acts []Action, o Options, oldSt, newSt *Stack) []Action {
	var gone []string
	for n := range oldSt.Files {
		if _, ok := newSt.Files[n]; !ok {
			gone = append(gone, n)
		}
	}
	sort.Strings(gone)
	var left []string
	for _, n := range gone {
		if _, err := os.Stat(filepath.Join(o.stackDir(), filepath.FromSlash(n))); err == nil {
			left = append(left, n)
		}
	}
	if len(gone) == 0 {
		return acts
	}
	pr := Action{"prune", "delete generated files the module set no longer has: " + strings.Join(gone, ", "), len(left) == 0,
		func(context.Context) error {
			for _, n := range gone {
				if err := os.Remove(filepath.Join(o.stackDir(), filepath.FromSlash(n))); err != nil && !os.IsNotExist(err) {
					return err
				}
			}
			return nil
		}}
	var out []Action
	for _, a := range acts {
		if a.ID == "up" {
			out = append(out, pr)
		}
		out = append(out, a)
	}
	return out
}

// assertGone: after a remove, none of the removed services may still be running.
func assertGone(ctx context.Context, h Host, o Options, st *Stack, gone []string) error {
	out, err := h.Run(ctx, "docker", o.composeArgs(st, "ps", "--all", "--format", "json")...)
	if err != nil {
		return fmt.Errorf("docker compose ps: %v", err)
	}
	for _, ln := range strings.Split(string(out), "\n") {
		ln = strings.TrimSpace(ln)
		if !strings.HasPrefix(ln, "{") {
			continue
		}
		var cr struct{ Service, State string }
		if json.Unmarshal([]byte(ln), &cr) == nil && contains(gone, cr.Service) && cr.State == "running" {
			return fmt.Errorf("%s is still running after its module was removed", cr.Service)
		}
	}
	return nil
}

// rollbackModule puts the previous generation back: files the new set added are
// deleted, the old files restored, `up` on the old digests, bytes of the old stack.
func rollbackModule(ctx context.Context, h Host, o Options, oldSt, newSt *Stack, prevRec *Receipt, prevDir string, cause error, out io.Writer) error {
	for n := range newSt.Files {
		if _, ok := oldSt.Files[n]; !ok {
			_ = os.Remove(filepath.Join(o.stackDir(), filepath.FromSlash(n)))
		}
	}
	if err := rollback(ctx, h, o, oldSt, prevRec, prevDir, cause, out); err != nil {
		return err
	}
	if r, _ := readReceipt(o.receiptPath()); r != nil {
		r.LastUpdateError, r.LastModuleError = "", cause.Error()
		return writeReceipt(o.receiptPath(), r)
	}
	return nil
}

// ModuleRollback is `bothy module rollback`: after an interruption, return to the
// generation saved before the unfinished change.
func ModuleRollback(ctx context.Context, h Host, o Options, out io.Writer) error {
	if err := RefuseRoot(h); err != nil {
		return err
	}
	if !o.DryRun {
		release, lerr := lockInstall(o.DataDir)
		if lerr != nil {
			return lerr
		}
		defer release()
	}
	rec, err := readReceipt(o.receiptPath())
	if err != nil {
		return err
	}
	if rec == nil || rec.Pending == nil {
		return fmt.Errorf("no module change is pending: there is nothing to roll back")
	}
	o.Mode, o.Bind, o.Port, o.ConfigDir = rec.Mode, rec.Bind, rec.Port, rec.ConfigDir
	prevDir := filepath.Join(o.DataDir, "previous")
	prevRec, err := readReceipt(filepath.Join(prevDir, "receipt.json"))
	if err != nil || prevRec == nil {
		return fmt.Errorf("the rollback point %s is not readable: %v", prevDir, err)
	}
	ms, err := Catalogue()
	if err != nil {
		return err
	}
	pd := rec.Pending
	oldSt, err := LoadStackSet(o.Mode, pd.From)
	if err != nil {
		return err
	}
	newSt, err := LoadStackSet(o.Mode, pd.To)
	if err != nil {
		return err
	}
	_ = ms
	if o.DryRun {
		fmt.Fprintf(out, "would roll back %s %s: restore the generation with modules %s, bring it up on its digests and verify it by bytes.\n", pd.Op, pd.Module, strings.Join(pd.From, ","))
		return nil
	}
	fmt.Fprintf(out, "rolling back the unfinished %s %s\n", pd.Op, pd.Module)
	return rollbackModule(context.WithoutCancel(ctx), h, o, oldSt, newSt, prevRec, prevDir, fmt.Errorf("rolled back by hand after an unfinished %s %s", pd.Op, pd.Module), out)
}
