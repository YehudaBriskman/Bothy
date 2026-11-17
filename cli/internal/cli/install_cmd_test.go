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
