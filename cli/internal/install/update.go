package install

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Update is `bothy update`: move an installed box to the release THIS binary
// belongs to (the stack definition is embedded in the binary, so a newer
// release arrives as a newer binary; fetching that binary is the user's step
// for now, decision Q4). It differs from re-running `bothy install` in what it
// does when something goes wrong:
//
//   - before anything on disk changes, the generated files and the receipt are
//     copied to <root>/previous/;
//   - any failure after that (a digest the registry lacks, a container that
//     never becomes healthy, bytes that do not match) restores those files,
//     brings the stack up again on the PREVIOUS receipt's digests, and proves
//     the old release by bytes before reporting the failure. Not "whatever is
//     running": the receipt names exactly what to go back to;
//   - the receipt records the release it replaced.
//
// Verification is install's: same-version manifest, its line in checksums.txt,
// `gh attestation verify` when gh is present, no downgrade. check only prints
// what would change.
func Update(ctx context.Context, h Host, o Options, check bool, out io.Writer) error {
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	rec, err := readReceipt(o.receiptPath())
	if err != nil {
		return err
	}
	if rec == nil {
		return fmt.Errorf("nothing is installed here (no receipt at %s): run `bothy install`", o.receiptPath())
	}
	if rec.Pending != nil {
		return pendingError(rec)
	}
	if rec.Status != "complete" {
		return fmt.Errorf("the last install did not finish (receipt says %q): run `bothy install` to resume it, then update", rec.Status)
	}
	if rec.DataDir != o.DataDir {
		return fmt.Errorf("the receipt says the install root is %s, not %s", rec.DataDir, o.DataDir)
	}
	o.Mode, o.Bind, o.Port, o.ConfigDir = rec.Mode, rec.Bind, rec.Port, rec.ConfigDir // an update never moves the box
	st, err := LoadStackSet(o.Mode, rec.Modules)                                      // the modules the box runs, not the mode's defaults
	if err != nil {
		return err
	}
	p("bothy update: %s %s -> release for binary %s (Compose runtime)", rec.Mode, rec.Version, o.BinaryVersion)

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
	if cmpVersion(m.Version, rec.Version) < 0 && !o.AllowDowngrade {
		return fmt.Errorf("installed version %s is newer than %s: refusing a downgrade (pass --allow-downgrade to force it)", rec.Version, m.Version)
	}

	if !check && !o.DryRun {
		release, lerr := lockInstall(o.DataDir)
		if lerr != nil {
			return lerr
		}
		defer release()
	}
	pf := Preflight(ctx, h, PreflightIn{Stack: st, Manifest: m, Bind: o.Bind, Port: o.Port, DataDir: nearest(o.DataDir),
		RealDataDir: o.DataDir, ConfigDir: o.ConfigDir, StackDir: o.stackDir(), OwnPortsOK: true})
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

	images := map[string]string{}
	for _, s := range st.Meta.Services {
		ref, err := m.Lookup(s.ImageKey, s.Own)
		if err != nil {
			return err
		}
		images[s.ImageVar] = ref
	}
	p("\nwhat changes:")
	p("  release  %s (%s) -> %s (%s)", rec.Version, short(rec.Commit), m.Version, short(m.Commit))
	changed := 0
	for _, v := range sortedKeys(images) {
		old := rec.Images[v]
		if old == images[v] {
			p("  %-24s unchanged", v)
			continue
		}
		changed++
		p("  %-24s %s -> %s", v, digestOf(old), digestOf(images[v]))
	}
	o.previous = &Previous{Version: rec.Version, Commit: rec.Commit, ManifestSHA256: rec.ManifestSHA256, Images: rec.Images}
	acts := buildPlan(h, o, st, m, msha, rec, images)
	pending := 0
	p("\nplan (%s; needs root: nothing; sudo is never run):", map[bool]string{true: "dry run", false: "apply"}[o.DryRun || check])
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
		p("\nup to date: this box already matches release %s.", m.Version)
		if check || o.DryRun {
			return nil
		}
		return verify(ctx, h, o, st, m, out)
	}
	if check || o.DryRun {
		p("\n%d image(s) would change, release %s -> %s. Nothing was changed.", changed, rec.Version, m.Version)
		return nil
	}

	// 1. the rollback point, before anything on disk moves.
	prevDir := filepath.Join(o.DataDir, "previous")
	p("\n-> keep the current release for rollback in %s", prevDir)
	if err := saveRollbackPoint(o, st, rec, prevDir); err != nil {
		return fmt.Errorf("cannot save the rollback point (nothing was changed): %w", err)
	}
	// 2. apply, in order; any failure rolls back.
	fail := func(step string, cause error) error {
		recordFailure(o, cause)
		p("\nupdate FAILED at %s: %v", step, cause)
		p("rolling back to %s (%s), the release in the receipt, using its digests", rec.Version, short(rec.Commit))
		if rerr := rollback(ctx, h, o, st, rec, prevDir, cause, out); rerr != nil {
			p("\nROLLBACK FAILED: %v", rerr)
			p("The box may be in a mixed state. The previous release's files are kept in %s; the receipt still says in-progress.", prevDir)
			p("Recover with the previous binary: `bothy install` (it re-applies release %s), or `bothy uninstall`.", rec.Version)
			return fmt.Errorf("%s: %v; rollback failed: %w", step, cause, rerr)
		}
		// The cause (often a multi-line compose log) was printed once above as
		// "update FAILED at ..."; the returned error is what the CLI prints last,
		// so it carries the cause in its chain (%w) but a short message.
		if m.Version == rec.Version {
			return fmt.Errorf("re-applying release %s failed at %s; the running release %s was restored: %w", m.Version, step, rec.Version, errShort{cause})
		}
		return fmt.Errorf("update to %s failed at %s and was rolled back to %s: %w", m.Version, step, rec.Version, errShort{cause})
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
	if err := verify(ctx, h, o, st, m, out); err != nil {
		return fail("verify", err)
	}
	r2, _ := readReceipt(o.receiptPath())
	if r2 != nil {
		r2.Status, r2.LastError, r2.LastUpdateError = "complete", "", ""
		if err := writeReceipt(o.receiptPath(), r2); err != nil {
			return err
		}
	}
	// Two generations are kept (the new one and the one to roll back to). The
	// release before that is no longer reachable by any rollback: its images go,
	// unless the other two still use them (digests are shared when unchanged).
	if rec.Previous != nil {
		keep := map[string]bool{}
		for _, ref := range images {
			keep[ref] = true
		}
		for _, ref := range rec.Images {
			keep[ref] = true
		}
		for _, ref := range sortedKeys(rec.Previous.Images) {
			if old := rec.Previous.Images[ref]; !keep[old] {
				if _, err := h.Run(ctx, "docker", "image", "rm", old); err == nil {
					p("   removed the image of release %s, which no rollback can reach any more: %s", rec.Previous.Version, digestOf(old))
				}
			}
		}
	}
	p("\nupdated: release %s -> %s. The previous release stays in %s (and its images are kept) until the next update.", rec.Version, m.Version, prevDir)
	return nil
}

func short(c string) string {
	if len(c) > 12 {
		return c[:12]
	}
	return c
}

func digestOf(ref string) string {
	if i := strings.Index(ref, "@sha256:"); i >= 0 && len(ref) >= i+8+12 {
		return ref[:strings.LastIndex(ref[:i], "/")+1] + "…" + ref[i+8:i+8+12]
	}
	if ref == "" {
		return "(none)"
	}
	return ref
}

// generatedFiles is every file the install writes into the stack directory.
func generatedFiles(st *Stack) []string {
	names := []string{"compose.yml", ".env"}
	for n := range st.Files {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func saveRollbackPoint(o Options, st *Stack, rec *Receipt, prevDir string) error {
	if err := os.RemoveAll(prevDir); err != nil {
		return err
	}
	if err := os.MkdirAll(prevDir, 0o700); err != nil {
		return err
	}
	for _, n := range generatedFiles(st) {
		b, err := os.ReadFile(filepath.Join(o.stackDir(), filepath.FromSlash(n)))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		dst := filepath.Join(prevDir, "stack", filepath.FromSlash(n))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return err
		}
	}
	// the receipt as it is now: complete, naming the digests to return to
	return writeReceipt(filepath.Join(prevDir, "receipt.json"), rec)
}

// rollback puts the previous release back: its files, then `up` on its digests
// (the images are still local: nothing removes them), then bytes for ITS commit.
func rollback(ctx context.Context, h Host, o Options, st *Stack, rec *Receipt, prevDir string, cause error, out io.Writer) error {
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	for _, n := range generatedFiles(st) {
		src := filepath.Join(prevDir, "stack", filepath.FromSlash(n))
		b, err := os.ReadFile(src)
		if err != nil {
			continue // it did not exist before the update
		}
		perm := os.FileMode(0o644)
		if n == ".env" {
			perm = 0o600
		}
		dst := filepath.Join(o.stackDir(), filepath.FromSlash(n))
		if err := atomicWrite(dst, b, perm); err != nil {
			return err
		}
	}
	p("   restored the previous generated files")
	for v, ref := range rec.Images {
		if _, err := h.Run(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", ref); err != nil {
			return fmt.Errorf("the previous image %s (%s) is no longer on this machine: %w", v, ref, err)
		}
	}
	if out2, err := h.Run(ctx, "docker", o.composeArgs(st, "up", "-d", "--wait", "--wait-timeout", o.waitTimeout(), "--pull", "never", "--remove-orphans")...); err != nil {
		return fmt.Errorf("docker compose up on the previous release: %v: %s", err, strings.TrimSpace(firstLine(string(out2))))
	}
	p("   previous release is up again")
	if err := verify(ctx, h, o, st, &Manifest{Commit: rec.Commit}, out); err != nil {
		return fmt.Errorf("the previous release does not verify: %w", err)
	}
	restored := *rec
	restored.Status = "complete"
	restored.LastError = ""
	restored.LastUpdateError = cause.Error()
	if err := writeReceipt(o.receiptPath(), &restored); err != nil {
		return err
	}
	p("   rolled back: release %s is running and verified by bytes; the receipt is as before, with last_update_error recorded", rec.Version)
	return nil
}

// errShort wraps a failure cause for the final error line: Error() is its
// first line only (the full text was already printed above), Unwrap keeps the
// whole cause for errors.Is/As.
type errShort struct{ err error }

func (e errShort) Error() string { return firstLine(e.err.Error()) }
func (e errShort) Unwrap() error { return e.err }
