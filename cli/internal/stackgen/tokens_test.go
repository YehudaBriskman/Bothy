package stackgen

import (
	"strings"
	"testing"
)

// Installed mode has no bothy-ops today, so it has no /v1 and no token store to mount. The day a
// mode adds bothy-ops, this fails until its token directory is mounted READ-ONLY (the repo
// compose's shape) and the stack still has no docker socket: tokens are minted on the host only.
func TestInstalledModeNeverRunsBothyOpsWithoutAReadOnlyTokenStore(t *testing.T) {
	out, err := Generate(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	for p, b := range out {
		if !strings.HasSuffix(p, "compose.yml.tmpl") {
			continue
		}
		s := string(b)
		if !strings.Contains(s, "bothy-ops:") {
			continue
		}
		if !strings.Contains(s, "/tokens:ro") {
			t.Errorf("%s runs bothy-ops without a read-only /tokens mount", p)
		}
		if strings.Contains(s, "docker.sock") || strings.Contains(s, "Host(") {
			t.Errorf("%s: socket or Host rule in an installed stack", p)
		}
	}
}
