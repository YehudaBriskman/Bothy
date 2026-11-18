package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/YehudaBriskman/Bothy/cli/internal/install"
)

// `bothy module add|remove|rollback` and the local `module list` change or read
// the module set of an INSTALLED box on THIS machine. Like install, update and
// token they are host-only and deliberately not catalog ops: no HTTP route, no
// MCP tool, no place in `discover` (cli_test.go pins that).
//
// `module list` is also a catalog op (the remote box's modules, MCP bothy_module_list).
// It runs locally when --local is given, or when this machine has an install
// receipt and no --url / BOTHY_URL / --context points elsewhere.

const moduleHelp = `bothy module - change the modules of an installed box (Docker Compose runtime)

  bothy module list [--json] [--local] [--root DIR]
  bothy module add NAME [--yes] [--dry-run] [--wait-timeout SECONDS] [--root DIR] [--config-dir DIR]
                        [--manifest SRC] [--checksums SRC] [--require-attestation]
  bothy module remove NAME [--dry-run] [--root DIR] [--config-dir DIR]
  bothy module rollback [--dry-run] [--root DIR] [--config-dir DIR]

A module is a unit with a declared memory cost and requirements (list shows them).
add checks the memory budget (what it ADDS plus the mode's reserve must fit in free
memory; the numbers are printed), pulls in required modules (asks, or --yes),
preflights, then applies like an update: the previous generation is kept, the new
one is brought up and health-checked by bytes, and any failure restores the
previous generation and proves it. remove refuses a core module and one that an
installed module needs; it keeps the module's data directories and image.
A module change never changes the release (that is "bothy update"). Re-running the
same command after an interruption resumes it; "module rollback" abandons it and
returns to the previous generation. --dry-run prints the plan and changes nothing.
`

// localModuleVerb reports whether `bothy module ...` is one of the host-only verbs.
func localModuleVerb(words []string, flags map[string]string, io IO) bool {
	if len(words) < 2 {
		return false
	}
	switch words[1] {
	case "add", "remove", "rollback":
		return true
	case "list":
		if flags["local"] == "true" || flags["root"] != "" {
			return true
		}
		if flags["url"] != "" || flags["context"] != "" || io.Getenv("BOTHY_URL") != "" {
			return false
		}
		data, _, err := installDirs(flags, io)
		if err != nil {
			return false
		}
		_, err = os.Stat(filepath.Join(data, "receipt.json"))
		return err == nil
	}
	return false
}

func cmdModule(args []string, flags map[string]string, g globals, io IO) error {
	if _, ok := flags["help"]; ok {
		fmt.Fprint(io.Out, moduleHelp)
		return nil
	}
	verb := args[0]
	args = args[1:]
	o, err := installOptions(flags, io)
	if err != nil {
		return err
	}
	if v := flags["wait-timeout"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 3600 {
			return usagef("--wait-timeout %q is not a number of seconds (1-3600)", v)
		}
		o.WaitTimeout = n
	}
	ctx, cancel := signalContext()
	defer cancel()
	switch verb {
	case "list":
		if len(args) > 0 {
			return usagef("module list takes flags, not arguments (got %q)", args[0])
		}
		return install.ModuleList(o, g.json, io.Out)
	case "rollback":
		if len(args) > 0 {
			return usagef("module rollback takes flags, not arguments (got %q)", args[0])
		}
		return install.ModuleRollback(ctx, install.SysHost{}, o, io.Out)
	}
	if len(args) != 1 {
		return usagef("module %s takes exactly one module name; try `bothy module list`", verb)
	}
	c := install.ModuleChange{Module: args[0], Yes: flags["yes"] == "true", In: io.In}
	if verb == "add" {
		return install.ModuleAdd(ctx, install.SysHost{}, o, c, io.Out)
	}
	return install.ModuleRemove(ctx, install.SysHost{}, o, c, io.Out)
}
