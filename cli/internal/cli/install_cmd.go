package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/YehudaBriskman/Bothy/cli/internal/install"
)

// installBase is where a release's metadata lives next to its binary.
const installBase = "https://github.com/YehudaBriskman/Bothy/releases/download"

const installHelp = `bothy install - install Bothy on this machine from the release this binary belongs to

  bothy install [--mode mini] [--bind 127.0.0.1] [--port 80] [--dry-run]
                [--root DIR] [--config-dir DIR] [--manifest SRC] [--checksums SRC]
                [--allow-downgrade]
  bothy update [--check] [--to vYYYY.M.N] [--this-release] [--dry-run] [--allow-downgrade]
               [--require-attestation] [--wait-timeout SECONDS] [--root DIR] [--config-dir DIR] [--manifest SRC] [--checksums SRC]
  bothy uninstall [--purge] [--dry-run] [--root DIR] [--config-dir DIR]

No git checkout, no build, no sudo. It needs Docker (Engine 25+, the compose
plugin) and a user who can use it. Everything it would do is printed first;
--dry-run prints it and stops. --mode mini is Bivvy (the only mode in this build).

  --bind     address the portal listens on (default 127.0.0.1: this machine only).
             Use 0.0.0.0 to reach it from other machines; the first login is then
             plain HTTP, so only do that on a network you trust.
  --manifest, --checksums   a path or https URL (default: this version's GitHub release)
  --require-attestation   make a skipped attestation check fatal (no gh, gh too old
             or not logged in, a network error, a local source). Without it those
             cases are skipped with a printed command; a verdict of "not attested"
             from gh is always fatal. The sha256 checks are never skipped.

update asks GitHub for the latest stable release (CalVer YYYY.M.N; drafts and
prereleases are ignored). When it is newer than this binary it downloads that
release's archive, checksums.txt and release-manifest.json, verifies them as
install does, replaces this binary (the old one is kept as bothy.prev next to it)
and then updates the box with the NEW binary (the stack definition travels inside
it); if the stack update fails the old binary is put back. --check only reports.
--to vX picks a release (older than this binary needs --allow-downgrade).
--this-release (also implied by --manifest or --checksums) skips GitHub and moves
the box to the release THIS binary belongs to, as before. That step verifies the
release exactly as install does (same-version HTTPS, the hash line in
checksums.txt, 'gh attestation verify' when a working gh is installed, otherwise
the exact command is printed and the check is said to be skipped) and refuses a downgrade.
--check prints what would change and changes nothing. The previous release is kept;
if the update fails at any step (a missing digest, a container that never becomes
healthy, bytes that do not match) the previous receipt's digests are restored and
verified by bytes before the failure is reported.

The files module serves ONE read-only notes folder, <root>/stack/bothy-files/notes,
and this install has no login: with --bind 0.0.0.0 anyone who can reach the port
can read that folder. Keep it to a network you trust, or keep the default bind.

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

func cmdUpdate(args []string, flags map[string]string, g globals, io IO) error {
	if len(args) > 0 {
		return usagef("update takes flags, not arguments (got %q); try `bothy update --help`", args[0])
	}
	if _, ok := flags["help"]; ok {
		fmt.Fprint(io.Out, installHelp)
		return nil
	}
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
	check := flags["check"] == "true"
	if flags["to"] == noValue {
		return usagef("flag --to needs a release like v2026.12.0")
	}
	explicit := flags["manifest"] != "" || flags["checksums"] != ""
	if g.json && check && flags["this-release"] != "true" && !explicit && flags["to"] == "" {
		// Machine output of `update --check`: the read-only signal, nothing else.
		// Every other combination behaves exactly as before.
		exe, _ := os.Executable()
		cwd, _ := os.Getwd()
		res := install.CheckRelease(ctx, install.DefaultSource(), io.Version, install.DetectKind(o.DataDir, filepath.Dir(exe), cwd))
		if err := res.WriteJSON(io.Out); err != nil {
			return err
		}
		if res.Error != "" {
			return fmt.Errorf("could not determine the latest release: %s", res.Error)
		}
		return nil
	}
	if flags["this-release"] != "true" && !explicit {
		so := install.SelfOptions{Source: install.DefaultSource(), To: flags["to"], Check: check || o.DryRun, ApplyArgs: applyArgs(flags)}
		handled, err := install.SelfUpdate(ctx, install.SysHost{}, o, so, io.Out)
		if err != nil || handled {
			return err
		}
	} else if flags["to"] != "" {
		return usagef("--to cannot be combined with --this-release, --manifest or --checksums")
	}
	return install.Update(ctx, install.SysHost{}, o, check, io.Out)
}

// applyArgs is the command line the NEW binary is run with to update the stack:
// the same box and policy flags, never a discovery flag (it must not look for
// yet another release).
func applyArgs(flags map[string]string) []string {
	a := []string{"update", "--this-release"}
	for _, k := range []string{"root", "config-dir", "wait-timeout"} {
		if v := flags[k]; v != "" && v != noValue {
			a = append(a, "--"+k+"="+v)
		}
	}
	for _, k := range []string{"allow-downgrade", "require-attestation"} {
		if flags[k] == "true" {
			a = append(a, "--"+k)
		}
	}
	return a
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
		BinaryVersion: io.Version, DryRun: flags["dry-run"] == "true", AllowDowngrade: flags["allow-downgrade"] == "true",
		RequireAttestation: flags["require-attestation"] == "true"}
	if v := flags["mode"]; v != "" {
		o.Mode = v
	}
	if v := flags["bind"]; v != "" {
		if net.ParseIP(v) == nil {
			return o, usagef("--bind %q is not an IP address (use 127.0.0.1, 0.0.0.0, or this machine's address)", v)
		}
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	// After the first signal the run winds down (and cleans up); a second one
	// gets the default behaviour back so a stuck cleanup can still be killed.
	go func() { <-ctx.Done(); stop() }()
	return ctx, stop
}
