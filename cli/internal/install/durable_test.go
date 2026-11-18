package install

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func codeOf(err error) int {
	var ce *CodedError
	if errors.As(err, &ce) {
		return ce.Code
	}
	if err == nil {
		return 0
	}
	return -1
}

// ---- refuse root (owner decision 1) ----

func TestEveryVerbRefusesRoot(t *testing.T) {
	for _, env := range []map[string]string{{"SUDO_USER": "dana"}, {}} {
		o := opts(t)
		o.DryRun = false
		h := newHost()
		h.euid = 0
		h.env = env
		ctx := context.Background()
		var out bytes.Buffer
		verbs := map[string]error{
			"install":   Install(ctx, h, o, &out),
			"update":    Update(ctx, h, o, false, &out),
			"uninstall": Uninstall(ctx, h, UninstallOptions{DataDir: o.DataDir, ConfigDir: o.ConfigDir}, &out),
			"add":       ModuleAdd(ctx, h, o, ModuleChange{Module: "node-metrics"}, &out),
			"remove":    ModuleRemove(ctx, h, o, ModuleChange{Module: "node-metrics"}, &out),
			"rollback":  ModuleRollback(ctx, h, o, &out),
		}
		_, selfErr := SelfUpdate(ctx, h, o, SelfOptions{}, &out)
		verbs["self-update"] = selfErr
		for name, err := range verbs {
			if codeOf(err) != ExitNotAllowed {
				t.Errorf("%s as root (%v): got %v, want exit 77", name, env, err)
				continue
			}
			if env["SUDO_USER"] != "" && !strings.Contains(err.Error(), "as dana without sudo") {
				t.Errorf("%s: sudo message does not tell dana what to do: %v", name, err)
			}
			if env["SUDO_USER"] == "" && !strings.Contains(err.Error(), "normal user") {
				t.Errorf("%s: root-login message lacks the fix: %v", name, err)
			}
		}
		// Not even a dry run, and nothing created.
		o.DryRun = true
		if codeOf(Install(ctx, h, o, &out)) != ExitNotAllowed {
			t.Error("a dry run as root was allowed")
		}
		if _, err := os.Stat(o.DataDir); err == nil {
			t.Error("root refusal created the install root")
		}
		if _, err := os.Stat(o.ConfigDir); err == nil {
			t.Error("root refusal created the config dir")
		}
	}
}

// ---- uninstall takes the lock (owner decision 2) ----

func TestUninstallTakesTheInstallLock(t *testing.T) {
	h, o, _ := applyFixture(t)
	if err := Install(context.Background(), h, o, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	release, err := lockInstall(o.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	uo := UninstallOptions{DataDir: o.DataDir, ConfigDir: o.ConfigDir}
	err = Uninstall(context.Background(), h, uo, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("uninstall ran under a held lock: %v", err)
	}
	if _, serr := os.Stat(o.receiptPath()); serr != nil {
		t.Fatal("receipt touched while the lock was held by someone else")
	}
	// a dry run needs no lock
	uo.DryRun = true
	if err := Uninstall(context.Background(), h, uo, &bytes.Buffer{}); err != nil {
		t.Fatalf("dry run: %v", err)
	}
	release()
	uo.DryRun = false
	if err := Uninstall(context.Background(), h, uo, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if _, serr := os.Stat(filepath.Join(o.DataDir, ".install.lock")); serr == nil {
		t.Error("lock file left behind")
	}
	if _, serr := os.Stat(o.DataDir); serr == nil {
		t.Error("an emptied install root was left behind")
	}
}

// ---- master.key: format, golden, round trip with the real reader (R2, DS7) ----

func TestMasterKeyMatchesTheSharedGolden(t *testing.T) {
	golden, err := os.ReadFile("testdata/master.key.golden")
	if err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	// The golden was produced by the settings library's own serializer (keyfile._serialize);
	// the installer's encoder must reproduce it byte for byte, and its parser must accept it.
	if got := EncodeMasterKey(key); !bytes.Equal(got, golden) {
		t.Fatalf("installer encoding differs from the library's:\n%q\n%q", got, golden)
	}
	if k, err := parseMasterKey(golden); err != nil || !bytes.Equal(k, key) {
		t.Fatalf("installer parser rejects the library's file: %v", err)
	}
}

// pyLoad asks the REAL settings-library reader (keyfile.load) to read path.
func pyLoad(t *testing.T, path string) (string, error) {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	lib, _ := filepath.Abs("../../../apps/bothy-settings")
	code := "import sys; sys.path.insert(0, sys.argv[1]); from bothy_settings import keyfile; ks = keyfile.load(sys.argv[2]); print(ks.active_id)"
	out, err := exec.Command(py, "-c", code, lib, path).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func TestInstallersKeyIsReadByTheSettingsLibrary(t *testing.T) {
	h, o, _ := applyFixture(t)
	if err := Install(context.Background(), h, o, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	key := filepath.Join(o.secretsDir(), "master.key")
	id, err := pyLoad(t, key)
	if err != nil {
		t.Fatalf("the settings library cannot read the installer's key: %v\n%s", err, id)
	}
	b, _ := os.ReadFile(key)
	k, _ := parseMasterKey(b)
	if id != keyID(k) {
		t.Fatalf("library key_id %q, installer %q", id, keyID(k))
	}
	// and a legacy hex key converted in place is read too, with the same 32 bytes
	legacy := bytes.Repeat([]byte{0xab}, 32)
	hexKey := strings.Repeat("ab", 32) + "\n"
	if err := os.WriteFile(key, []byte(hexKey), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureMasterKey(key); err != nil {
		t.Fatal(err)
	}
	if id, err := pyLoad(t, key); err != nil || id != keyID(legacy) {
		t.Fatalf("converted legacy key: %v %q (want %s)", err, id, keyID(legacy))
	}
}

func TestMasterKeyParserRefusesWhatTheLibraryRefuses(t *testing.T) {
	good := string(EncodeMasterKey(bytes.Repeat([]byte{7}, 32)))
	for name, bad := range map[string]string{
		"no header":      strings.TrimPrefix(good, keyHeader+"\n"),
		"wrong id":       strings.Replace(good, good[len(keyHeader)+1:len(keyHeader)+3], "zz", 1),
		"short key":      keyHeader + "\n0000000000000000 AAAA\n",
		"header only":    keyHeader + "\n",
		"extra column":   strings.TrimSuffix(good, "\n") + " x\n",
		"hex, not b64":   strings.Repeat("ab", 32) + "\n",
		"truncated line": good[:len(good)-12],
	} {
		if _, err := parseMasterKey([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLegacyKeyIsConvertedNotRegenerated(t *testing.T) {
	dir := t.TempDir()
	key := filepath.Join(dir, "master.key")
	hexKey := "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\n"
	if err := os.WriteFile(key, []byte(hexKey), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ensureMasterKey(key); err != nil {
		t.Fatal(err)
	}
	golden, _ := os.ReadFile("testdata/master.key.golden")
	if b, _ := os.ReadFile(key); !bytes.Equal(b, golden) {
		t.Fatalf("legacy 0x00..0x1f key not converted to the golden: %q", b)
	}
}

func TestCorruptKeyIsRefusedWith74AndLeftAlone(t *testing.T) {
	key := filepath.Join(t.TempDir(), "master.key")
	torn := "bothy-master-key v1\n630dcd2966c43366 AAECAwQF" // a short write left at the target
	_ = os.WriteFile(key, []byte(torn), 0o600)
	if st, _ := keyState(key); st != "corrupt" {
		t.Fatalf("a short key file is %q, must be corrupt and so never 'done'", st)
	}
	err := ensureMasterKey(key)
	if codeOf(err) != ExitCorrupt {
		t.Fatalf("got %v", err)
	}
	if b, _ := os.ReadFile(key); string(b) != torn {
		t.Fatal("a corrupt key was modified")
	}
}

// ---- T4: a crash at every step of a durable write (R5) ----

var stages = []string{"written", "synced", "renamed"}

func TestKeyWriteInterruptedAtEveryStep(t *testing.T) {
	for _, stage := range stages {
		dir := t.TempDir()
		key := filepath.Join(dir, "master.key")
		writeHook = func(s string) error {
			if s == stage {
				return errors.New("killed at " + s)
			}
			return nil
		}
		err := ensureMasterKey(key)
		writeHook = nil
		if err == nil {
			t.Fatalf("%s: hook did not fire", stage)
		}
		// The target is either absent or COMPLETE: never a short key.
		if b, rerr := os.ReadFile(key); rerr == nil {
			if _, perr := parseMasterKey(b); perr != nil {
				t.Errorf("%s: a torn key was left at the target: %q", stage, b)
			}
		}
		// The next run completes (a leftover that parses is kept, never replaced).
		if err := ensureMasterKey(key); err != nil {
			t.Fatalf("%s: next run: %v", stage, err)
		}
		b, _ := os.ReadFile(key)
		if _, perr := parseMasterKey(b); perr != nil {
			t.Errorf("%s: key after the next run does not parse", stage)
		}
		if st, _ := keyState(key); st != "ok" {
			t.Errorf("%s: state %s", stage, st)
		}
	}
}

func TestReceiptWriteInterruptedAtEveryStep(t *testing.T) {
	for _, stage := range stages {
		dir := t.TempDir()
		path := filepath.Join(dir, "receipt.json")
		if err := writeReceipt(path, &Receipt{Status: "complete", Version: "old"}); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(path)
		writeHook = func(s string) error {
			if s == stage {
				return errors.New("killed at " + s)
			}
			return nil
		}
		err := writeReceipt(path, &Receipt{Status: "complete", Version: "new"})
		writeHook = nil
		if err == nil {
			t.Fatalf("%s: hook did not fire", stage)
		}
		r, rerr := readReceipt(path)
		if rerr != nil || r == nil {
			t.Fatalf("%s: receipt unreadable after a crash: %v", stage, rerr)
		}
		// old before the rename, new after it; never a mixture
		want := "old"
		if stage == "renamed" {
			want = "new"
		}
		if r.Version != want {
			t.Errorf("%s: version %q, want %q (before: %s)", stage, r.Version, want, before)
		}
		if err := writeReceipt(path, &Receipt{Status: "complete", Version: "next"}); err != nil {
			t.Fatalf("%s: next write: %v", stage, err)
		}
		if m, _ := filepath.Glob(path + ".tmp*"); stage != "renamed" && len(m) != 0 {
			t.Errorf("%s: temp files left: %v", stage, m)
		}
	}
}

// ---- receipt verdicts (DS1): too new 78, corrupt 74, file untouched ----

func TestReceiptVerdicts(t *testing.T) {
	for name, c := range map[string]struct {
		body string
		code int
	}{
		"too new":        {`{"schema": 3, "status": "complete"}`, ExitVersion},
		"corrupt":        {`{"schema": 2, "status": "compl`, ExitCorrupt},
		"no schema":      {`{"status": "complete"}`, ExitCorrupt},
		"schema a word":  {`{"schema": "two"}`, ExitCorrupt},
		"schema zero":    {`{"schema": 0}`, ExitCorrupt},
		"current schema": {`{"schema": 2, "status": "complete"}`, 0},
		"schema 1":       {`{"schema": 1, "status": "complete"}`, 0},
	} {
		path := filepath.Join(t.TempDir(), "receipt.json")
		_ = os.WriteFile(path, []byte(c.body), 0o600)
		_, err := readReceipt(path)
		if got := codeOf(err); got != c.code {
			t.Errorf("%s: code %d (%v), want %d", name, got, err, c.code)
		}
		if b, _ := os.ReadFile(path); string(b) != c.body {
			t.Errorf("%s: the file was modified", name)
		}
	}
}

func TestReceiptCarriesItsSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "receipt.json")
	if err := writeReceipt(path, &Receipt{Status: "complete"}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), `"schema": 2`) {
		t.Fatalf("no schema in %s", b)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}
}
