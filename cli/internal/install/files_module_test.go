package install

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The files module's roots policy, held: one read-only root, no write route,
// no sandbox origin, three independent read-only controls, and the RAM gate
// counting it.
func TestFilesModuleIsReadOnlyAndRoutedReadOnly(t *testing.T) {
	st := mini(t)
	var files *struct{ n, mem int }
	for _, s := range st.Meta.Services {
		if s.Name == "bothy-files" {
			files = &struct{ n, mem int }{1, s.MemMiB}
		}
	}
	if files == nil || files.mem != 256 {
		t.Fatalf("mini has no bothy-files service with its 256m limit: %+v", st.Meta.Services)
	}
	c := string(st.Compose)
	for _, must := range []string{"./bothy-files/notes:/repos/notes:ro", "read_only: true", "no-new-privileges:true", "- /audit"} {
		if !strings.Contains(c, must) {
			t.Errorf("compose lacks %q", must)
		}
	}
	for _, bad := range []string{"/repos/stacks", "/repos/home", "/repos/projects", "notes:rw", "docker.sock", ":8100"} {
		if strings.Contains(c, bad) {
			t.Errorf("compose contains %q", bad)
		}
	}
	routes := string(st.Files["traefik/dynamic/routes.yml"])
	for _, bad := range []string{"/-/api/files/write", "/-/api/files/delete", "/-/api/files/raw", "/-/api/files/archive", "/-/api/config", "sandbox", "sso-"} {
		if strings.Contains(routes, bad) {
			t.Errorf("routes expose %q", bad)
		}
	}
	if !strings.Contains(routes, "/-/api/files/roots") || !strings.Contains(routes, "X-Auth-Request-User") {
		t.Error("read routes or the identity-header strip are missing")
	}
	pol := string(st.Files["bothy-files/policy/policy.toml"])
	if !regexp.MustCompile(`(?s)\[roots\.notes\]\npath = "/repos/notes"\nwritable = false`).MatchString(pol) || strings.Count(pol, "[roots.") != 1 {
		t.Error("installed policy must declare exactly one root, notes, writable = false")
	}
	// RAM gate: traefik 128 + web 64 + files 256 + reserve 512
	sum := st.Meta.ReserveMiB
	for _, s := range st.Meta.Services {
		sum += s.MemMiB
	}
	if sum != 960 {
		t.Errorf("RAM gate is %d MiB, want 960", sum)
	}
}

// [deny] and [sensitive] of the installed policy are the shipped policy's, byte
// for byte: the secret-shaped-name rules must not fork.
func TestInstalledFilesPolicyTracksTheShippedOne(t *testing.T) {
	section := func(path, name, next string) string {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		s := string(b)
		i := strings.Index(s, "\n["+name+"]\n")
		j := strings.Index(s[i+1:], "\n["+next+"]\n")
		if i < 0 || j < 0 {
			t.Fatalf("%s: cannot find [%s]..[%s]", path, name, next)
		}
		return s[i : i+1+j]
	}
	for _, p := range [][2]string{{"deny", "sensitive"}, {"sensitive", "snapshots"}} {
		a := section("../../../apps/bothy-files/policy.toml", p[0], p[1])
		b := section("../../../stack/installed/bothy-files.policy.toml", p[0], p[1])
		// the shipped file has comment lines between sections; compare the data lines only
		strip := func(s string) string {
			var o []string
			for _, l := range strings.Split(s, "\n") {
				if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
					o = append(o, t)
				}
			}
			return strings.Join(o, "\n")
		}
		if strip(a) != strip(b) {
			t.Errorf("[%s] drifted from apps/bothy-files/policy.toml: re-copy it (see the header of stack/installed/bothy-files.policy.toml)", p[0])
		}
	}
}
