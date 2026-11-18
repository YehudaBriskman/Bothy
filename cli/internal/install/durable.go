package install

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Exit codes the install verbs use for the format verdicts of
// docs/plans/thin-bothy/data-and-state.md DS1 (sysexits): one code per verdict,
// so a script or the web updater branches without parsing prose.
const (
	ExitNotAllowed = 77 // EX_NOPERM: refused to run as root
	ExitVersion    = 78 // too new (or too old): a different bothy must read this
	ExitCorrupt    = 74 // EX_IOERR: the file does not parse; never recreated
)

// CodedError is an error that carries the process exit code the CLI returns.
type CodedError struct {
	Code int
	Msg  string
}

func (e *CodedError) Error() string { return e.Msg }

// ExitCode implements the interface the CLI looks for.
func (e *CodedError) ExitCode() int { return e.Code }

// RefuseRoot stops every install verb that would write as root. Running under
// sudo or as a real root login puts the data, the secrets and the compose
// project in root's name (or in a home directory that belongs to somebody
// else), which the normal user can then neither update nor remove. There is
// deliberately no override: a box that needs root has no use for a per-user
// install (system scope is a later, separate design).
func RefuseRoot(h Host) error {
	if h.Euid() != 0 {
		return nil
	}
	if su := h.Getenv("SUDO_USER"); su != "" && su != "root" {
		return &CodedError{ExitNotAllowed, fmt.Sprintf("refusing to run as root (sudo, on behalf of %s): the install would be owned by root and %s could not update or remove it. Nothing was changed. Run it as %s without sudo: `bothy install` (once: `sudo usermod -aG docker %s`, then log in again)", su, su, su, su)}
	}
	return &CodedError{ExitNotAllowed, "refusing to run as root: the install would be owned by root's home and a normal user could not update or remove it. Nothing was changed. Log in as a normal user who is in the docker group (`sudo adduser <name> docker`) and run `bothy install` there"}
}

// ---- crash-safe writes ---------------------------------------------------

// writeHook is a test seam, the same idea as the settings library's
// _restore_hook: it is called between the steps of a durable write and a
// non-nil return aborts there, as a kill would. Nil in production.
var writeHook func(stage string) error

func hook(stage string) error {
	if writeHook != nil {
		return writeHook(stage)
	}
	return nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}

// writeTemp writes data to a fresh, uniquely named, fsynced temp file in dir.
func writeTemp(dir, base string, data []byte, perm os.FileMode) (string, error) {
	f, err := os.CreateTemp(dir, base+".tmp-*")
	if err != nil {
		return "", err
	}
	name := f.Name()
	fail := func(e error) (string, error) { _ = f.Close(); _ = os.Remove(name); return "", e }
	if err := f.Chmod(perm); err != nil {
		return fail(err)
	}
	if _, err := f.Write(data); err != nil {
		return fail(err)
	}
	if err := hook("written"); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}

// atomicWrite replaces path with data: temp file in the same directory, fsync,
// rename, fsync of the directory. A reader sees the old file or the new one.
func atomicWrite(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := writeTemp(dir, filepath.Base(path), data, perm)
	if err != nil {
		return err
	}
	if err := hook("synced"); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := hook("renamed"); err != nil {
		return err
	}
	return syncDir(dir)
}

// createExclusive makes path with data only if it does not exist: link(2) of a
// fully written, fsynced temp file (the settings library's creation rule), so
// a crash never leaves a short file at the target and nothing is overwritten.
func createExclusive(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := writeTemp(dir, filepath.Base(path), data, perm)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err := hook("synced"); err != nil {
		return err
	}
	if err := os.Link(tmp, path); err != nil {
		return err
	}
	if err := hook("renamed"); err != nil {
		return err
	}
	return syncDir(dir)
}

// ---- master.key: the settings library's format (DS7) ---------------------

const keyHeader = "bothy-master-key v1"

func keyID(key []byte) string {
	s := sha256.Sum256(key)
	return hex.EncodeToString(s[:8])
}

// EncodeMasterKey is the exact file the settings library reads:
//
//	bothy-master-key v1
//	<key_id> <base64 of 32 bytes>
func EncodeMasterKey(key []byte) []byte {
	return []byte(keyHeader + "\n" + keyID(key) + " " + base64.StdEncoding.EncodeToString(key) + "\n")
}

// parseMasterKey applies the library's keyfile._parse (every line must be valid).
func parseMasterKey(b []byte) ([]byte, error) {
	lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
	if len(lines) < 2 || lines[0] != keyHeader {
		return nil, errors.New("header missing")
	}
	var first []byte
	for i, ln := range lines[1:] {
		parts := strings.Split(ln, " ")
		if len(parts) != 2 {
			return nil, fmt.Errorf("line %d is not '<key_id> <base64>'", i+2)
		}
		k, err := base64.StdEncoding.Strict().DecodeString(parts[1])
		if err != nil || len(k) != 32 {
			return nil, fmt.Errorf("line %d is not a 32-byte base64 key", i+2)
		}
		if parts[0] != keyID(k) {
			return nil, fmt.Errorf("line %d key_id does not match its key", i+2)
		}
		if first == nil {
			first = k
		}
	}
	return first, nil
}

// legacyHexKey recognises the installer's old format: 64 hex characters.
func legacyHexKey(b []byte) ([]byte, bool) {
	s := strings.TrimSpace(string(b))
	if len(s) != 64 {
		return nil, false
	}
	k, err := hex.DecodeString(s)
	return k, err == nil
}

// keyState: "ok" (library format, parses), "legacy" (old hex, convertible),
// "empty" (an interrupted write: holds nothing, safe to regenerate),
// "missing", "corrupt" (anything else: never replaced).
func keyState(path string) (string, error) {
	b, rerr := os.ReadFile(path)
	if errors.Is(rerr, os.ErrNotExist) {
		return "missing", nil
	}
	if rerr != nil {
		return "", rerr
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return "empty", nil
	}
	if _, perr := parseMasterKey(b); perr == nil {
		return "ok", nil
	}
	if _, ok := legacyHexKey(b); ok {
		return "legacy", nil
	}
	return "corrupt", nil
}

// ensureMasterKey brings path to a valid library-format key. A valid key is
// left alone; a legacy hex key becomes the same 32 bytes in the new format; an
// empty file or none is generated; anything else is refused (exit 74), because
// a key is never overwritten.
func ensureMasterKey(path string) error {
	st, err := keyState(path)
	if err != nil {
		return err
	}
	switch st {
	case "ok":
		return nil
	case "corrupt":
		return &CodedError{ExitCorrupt, fmt.Sprintf("%s is not a valid master key (corrupt). Nothing was changed and it will not be replaced, because anything encrypted with it would be lost. Restore it from your copy, or move it aside if the box holds nothing encrypted yet", path)}
	case "legacy":
		b, _ := os.ReadFile(path)
		k, _ := legacyHexKey(b)
		return atomicWrite(path, EncodeMasterKey(k), 0o600)
	case "empty":
		_ = os.Remove(path)
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return err
	}
	return createExclusive(path, EncodeMasterKey(k), 0o600)
}
