package install

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// PurgePhrase is what a person must type to delete data.
const PurgePhrase = "delete bothy data"

// UninstallOptions is the input of `bothy uninstall`.
type UninstallOptions struct {
	DataDir   string
	ConfigDir string // used only when no receipt says otherwise
	Purge     bool
	DryRun    bool
	In        io.Reader
}

// Uninstall removes what `bothy install` started and generated. It keeps
// everything that could be data (secrets, bind directories with content, pulled
// images) unless --purge is given AND the phrase is typed.
func Uninstall(ctx context.Context, h Host, o UninstallOptions, out io.Writer) error {
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	rpath := filepath.Join(o.DataDir, "receipt.json")
	rec, err := readReceipt(rpath)
	if err != nil {
		return err
	}
	if rec == nil {
		p("nothing to uninstall: no receipt at %s", rpath)
		return nil
	}
	st, err := LoadStack(rec.Mode)
	if err != nil {
		return err
	}
	io2 := Options{DataDir: rec.DataDir, ConfigDir: rec.ConfigDir}
	if rec.DataDir != o.DataDir {
		return fmt.Errorf("the receipt says the install root is %s, not %s", rec.DataDir, o.DataDir)
	}
	stackDir := io2.stackDir()

	p("bothy uninstall: %s %s (receipt %s)", rec.Mode, rec.Version, rpath)
	type step struct {
		desc string
		run  func() error
	}
	var steps []step
	steps = append(steps, step{"docker compose down --remove-orphans (project " + rec.Project + "): removes the containers and the network, no volumes", func() error {
		if _, err := os.Stat(filepath.Join(stackDir, "compose.yml")); err != nil {
			return nil
		}
		o2 := Options{DataDir: rec.DataDir}
		if out, err := h.Run(ctx, "docker", o2.composeArgs(st, "down", "--remove-orphans")...); err != nil {
			return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}})
	gen := append([]string{"compose.yml", ".env"}, st.Meta.Files...)
	steps = append(steps, step{fmt.Sprintf("delete the generated files %s in %s", strings.Join(gen, ", "), stackDir), func() error {
		for _, n := range gen {
			if err := os.Remove(filepath.Join(stackDir, filepath.FromSlash(n))); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		return nil
	}})
	steps = append(steps, step{"remove the stack directories only if they are empty (os.Remove, never recursive); a directory with content is KEPT", func() error {
		dirs := append([]string{}, st.Meta.Mkdirs...)
		for i := len(dirs) - 1; i >= 0; i-- { // deepest first is enough: Mkdirs is sorted, parents sort first
			_ = os.Remove(filepath.Join(stackDir, filepath.FromSlash(dirs[i])))
		}
		for _, s := range st.Meta.Services {
			_ = os.Remove(filepath.Join(stackDir, s.Name))
		}
		_ = os.Remove(stackDir)
		return nil
	}})
	if o.Purge {
		steps = append(steps, step{"PURGE: delete the secrets directory " + filepath.Join(rec.ConfigDir, "secrets") + " (includes master.key: anything encrypted with it becomes unreadable)", func() error {
			return guardedRemoveAll(filepath.Join(rec.ConfigDir, "secrets"), "secrets")
		}})
		steps = append(steps, step{"PURGE: docker image rm for the pulled images", func() error {
			for _, ref := range rec.Images {
				_, _ = h.Run(ctx, "docker", "image", "rm", ref) // best effort; in use or shared is fine
			}
			return nil
		}})
		steps = append(steps, step{"PURGE: delete the install root " + rec.DataDir, func() error {
			return guardedRemoveAll(rec.DataDir, "bothy")
		}})
	} else {
		steps = append(steps, step{"delete the receipt " + rpath + " (secrets in " + filepath.Join(rec.ConfigDir, "secrets") + " and pulled images are kept)", func() error {
			return os.Remove(rpath)
		}})
	}
	for _, s := range steps {
		p("  - %s", s.desc)
	}
	if o.DryRun {
		p("\ndry run: nothing was changed.")
		return nil
	}
	if o.Purge {
		p("\nThis deletes data. Type exactly %q to continue, anything else aborts:", PurgePhrase)
		line, _ := bufio.NewReader(o.In).ReadString('\n')
		if strings.TrimSpace(line) != PurgePhrase {
			p("aborted: nothing was changed.")
			return fmt.Errorf("purge not confirmed")
		}
	}
	for _, s := range steps {
		if err := s.run(); err != nil {
			return fmt.Errorf("%s: %w", s.desc, err)
		}
	}
	if o.Purge {
		p("\npurged.")
	} else {
		p("\nuninstalled. Kept: secrets and any data directories. `bothy uninstall --purge` deletes them (typed confirmation).")
	}
	return nil
}

// guardedRemoveAll refuses anything that is not a real directory whose name is
// `wantBase` (or lives under such a directory): the install root is user
// supplied, and `rm -rf` on a wrong path is the one unrecoverable mistake.
func guardedRemoveAll(dir, wantBase string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if fi, err := os.Lstat(abs); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	} else if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return fmt.Errorf("refusing to delete %s: not a plain directory", abs)
	}
	home, _ := os.UserHomeDir()
	if abs == "/" || abs == home || filepath.Base(abs) != wantBase {
		return fmt.Errorf("refusing to delete %s: it is not a directory named %q", abs, wantBase)
	}
	return os.RemoveAll(abs)
}
