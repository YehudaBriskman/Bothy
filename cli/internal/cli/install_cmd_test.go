package cli

import (
	"strings"
	"testing"
)

func TestApplyArgsForwardsPolicyNeverDiscovery(t *testing.T) {
	_, flags, err := splitArgs([]string{"--root", "/x/bothy", "--to", "v2026.12.0", "--check", "--allow-downgrade", "--require-attestation", "--wait-timeout=9"})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(applyArgs(flags), " ")
	want := "update --this-release --root=/x/bothy --wait-timeout=9 --allow-downgrade --require-attestation"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

// --json changes nothing for an update that is not `--check`: it still runs the
// old path, which stops at the missing receipt before any network call.
func TestUpdateJSONWithoutCheckIsTheOldPath(t *testing.T) {
	var out, errb strings.Builder
	root := t.TempDir() + "/bothy"
	code := Run([]string{"--json", "update", "--root", root, "--config-dir", t.TempDir() + "/bothy"},
		IO{In: strings.NewReader(""), Out: &out, Err: &errb, Getenv: func(k string) string {
			if k == "HOME" {
				return t.TempDir()
			}
			return ""
		}, Version: "2026.11.2"})
	if code == 0 || !strings.Contains(errb.String(), "nothing is installed here") || out.Len() != 0 {
		t.Errorf("code=%d out=%q err=%q", code, out.String(), errb.String())
	}
}
