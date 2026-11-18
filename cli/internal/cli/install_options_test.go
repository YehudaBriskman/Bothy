package cli

import (
	"strings"
	"testing"
)

func TestInstallOptionsBindAndPaths(t *testing.T) {
	env := map[string]string{"HOME": "/home/José Smith"}
	io := IO{Getenv: func(k string) string { return env[k] }, Version: "2026.11.0"}

	for _, bad := range []string{"localhost", "foo", "127.0.0", "80"} {
		if _, err := installOptions(map[string]string{"bind": bad}, io); err == nil || !strings.Contains(err.Error(), "not an IP address") {
			t.Errorf("--bind %q: %v", bad, err)
		}
	}
	for _, good := range []string{"127.0.0.1", "0.0.0.0", "::1", "192.168.1.5"} {
		if _, err := installOptions(map[string]string{"bind": good}, io); err != nil {
			t.Errorf("--bind %q refused: %v", good, err)
		}
	}
	// A home with a space and a non-ASCII name is an ordinary home.
	o, err := installOptions(map[string]string{}, io)
	if err != nil || !strings.HasPrefix(o.DataDir, "/home/José Smith/.local/share/bothy") || !strings.HasPrefix(o.ConfigDir, "/home/José Smith/.config/bothy") {
		t.Fatalf("%+v %v", o, err)
	}
	// No HOME at all is a clear error, not a path under "".
	if _, err := installOptions(map[string]string{}, IO{Getenv: func(string) string { return "" }}); err == nil || !strings.Contains(err.Error(), "HOME") {
		t.Errorf("empty HOME: %v", err)
	}
}
