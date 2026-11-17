package cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/YehudaBriskman/Bothy/cli/internal/install"
)

// installBase is where a release's metadata lives next to its binary.
const installBase = "https://github.com/YehudaBriskman/Bothy/releases/download"

const installHelp = `bothy install - install Bothy on this machine from the release this binary belongs to

  bothy install [--mode mini] [--bind 127.0.0.1] [--port 80] [--dry-run]
                [--root DIR] [--config-dir DIR] [--manifest SRC] [--checksums SRC]
                [--allow-downgrade]
  bothy uninstall [--purge] [--dry-run] [--root DIR] [--config-dir DIR]

No git checkout, no build, no sudo. It needs Docker (Engine 25+, the compose
plugin) and a user who can use it. Everything it would do is printed first;
--dry-run prints it and stops. --mode mini is Bivvy (the only mode in this build).

  --bind     address the portal listens on (default 127.0.0.1: this machine only).
             Use 0.0.0.0 to reach it from other machines; the first login is then
             plain HTTP, so only do that on a network you trust.
  --manifest, --checksums   a path or https URL (default: this version's GitHub release)

uninstall removes the containers, network and generated files and keeps secrets
and data. --purge also deletes them, after you type a confirmation phrase.
`

func cmdInstall(args []string, flags map[string]string, g globals, io IO) error {
	if len(args) > 0 {
		return usagef("install takes flags, not arguments (got %q); try `bothy install --help`", args[0])
	}
	if _, ok := flags["help"]; ok {
		fmt.Fprint(io.Out, installHelp)
		return nil
	}
	o, err := installOptions(flags, io)
	if err != nil {
		return err
	}
	ctx, cancel := signalContext()
	defer cancel()
	return install.Install(ctx, install.SysHost{}, o, io.Out)
}

func cmdUninstall(args []string, flags map[string]string, g globals, io IO) error {
	if len(args) > 0 {
		return usagef("uninstall takes flags, not arguments (got %q)", args[0])
	}
	if _, ok := flags["help"]; ok {
		fmt.Fprint(io.Out, installHelp)
		return nil
	}
	data, conf, err := installDirs(flags, io)
	if err != nil {
		return err
	}
	ctx, cancel := signalContext()
	defer cancel()
	return install.Uninstall(ctx, install.SysHost{}, install.UninstallOptions{
		DataDir: data, ConfigDir: conf, Purge: flags["purge"] == "true", DryRun: flags["dry-run"] == "true", In: io.In,
	}, io.Out)
}

func installDirs(flags map[string]string, io IO) (data, conf string, err error) {
	home := io.Getenv("HOME")
	if home == "" {
		return "", "", fmt.Errorf("HOME is not set")
	}
	data = flags["root"]
	if data == "" {
		base := io.Getenv("XDG_DATA_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "share")
		}
		data = filepath.Join(base, "bothy")
	}
	conf = flags["config-dir"]
	if conf == "" {
		base := io.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		conf = filepath.Join(base, "bothy")
	}
	for _, d := range []string{data, conf} {
		if !filepath.IsAbs(d) {
			return "", "", usagef("%s must be an absolute path", d)
		}
		if filepath.Base(d) != "bothy" {
			return "", "", usagef("%s: the install root and config directory must be named \"bothy\" (so a purge can never point at something else)", d)
		}
	}
	return filepath.Clean(data), filepath.Clean(conf), nil
}

func installOptions(flags map[string]string, io IO) (install.Options, error) {
	data, conf, err := installDirs(flags, io)
	if err != nil {
		return install.Options{}, err
	}
	o := install.Options{Mode: "mini", Bind: "127.0.0.1", DataDir: data, ConfigDir: conf,
		BinaryVersion: io.Version, DryRun: flags["dry-run"] == "true", AllowDowngrade: flags["allow-downgrade"] == "true"}
	if v := flags["mode"]; v != "" {
		o.Mode = v
	}
	if v := flags["bind"]; v != "" {
		o.Bind = v
	}
	if v := flags["port"]; v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 65535 {
			return o, usagef("--port %q is not a port number", v)
		}
		o.Port = n
	}
	found := false
	for _, m := range install.Modes() {
		found = found || m == o.Mode
	}
	if !found {
		return o, usagef("mode %q is not in this build (have: %s)", o.Mode, strings.Join(install.Modes(), ", "))
	}
	base := installBase + "/v" + strings.TrimPrefix(io.Version, "v")
	o.ManifestSrc, o.ChecksumsSrc = flags["manifest"], flags["checksums"]
	if o.ManifestSrc == "" {
		o.ManifestSrc = base + "/release-manifest.json"
	}
	if o.ChecksumsSrc == "" {
		o.ChecksumsSrc = base + "/checksums.txt"
	}
	return o, nil
}

func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt)
}
