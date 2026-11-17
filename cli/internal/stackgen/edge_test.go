package stackgen

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const repoRoot = "../../.."

// The golden is the generated file-provider config of the real repo. Regenerate
// with UPDATE_GOLDEN=1 go test ./internal/stackgen; the diff is what to review.
func TestMiniEdgeGolden(t *testing.T) {
	out, err := Generate(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	got := out["stack/mini/files/traefik/dynamic/routes.yml"]
	golden := filepath.Join("testdata", "mini-routes.golden.yml")
	if os.Getenv("UPDATE_GOLDEN") != "" {
		_ = os.MkdirAll("testdata", 0o755)
		if err := os.WriteFile(golden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != string(got) {
		t.Fatalf("generated dynamic config differs from %s (UPDATE_GOLDEN=1 to accept):\n%s", golden, got)
	}
}

// The installed edge's security properties, on every mode of the real repo.
func TestInstalledEdgeIsSocketlessAndHostless(t *testing.T) {
	out, err := Generate(repoRoot)
	if err != nil {
		t.Fatal(err)
	}
	for p, b := range out {
		s := string(b)
		switch {
		case strings.HasSuffix(p, "compose.yml.tmpl"):
			for _, bad := range []string{"docker.sock", "providers.docker", "api.dashboard", "api.insecure", "host-gateway", "8100", "network_mode", "privileged", "Host("} {
				if strings.Contains(s, bad) {
					t.Errorf("%s contains %q", p, bad)
				}
			}
			if !strings.Contains(s, "--providers.file.directory=/etc/traefik/dynamic") || !strings.Contains(s, "--api=true") {
				t.Errorf("%s lacks the file provider or the API", p)
			}
			// the only published port is the one modes.yml lists
			if strings.Count(s, "ports:") != 1 || strings.Count(s, "${BOTHY_HTTP_PORT:-80}:80") != 1 {
				t.Errorf("%s publishes something other than the portal port:\n%s", p, s)
			}
			// the internal entrypoint is loopback inside the container
			if !strings.Contains(s, "--entrypoints.metrics.address=127.0.0.1:8899") || strings.Contains(s, "address=:8899") {
				t.Errorf("%s: metrics entrypoint is not loopback", p)
			}
		case strings.HasSuffix(p, "routes.yml"):
			if hostRuleRe.MatchString(noComments(s)) {
				t.Errorf("%s has a Host rule", p)
			}
			if strings.Contains(s, "api@internal") || strings.Contains(s, "PathPrefix(`/-/") {
				t.Errorf("%s routes the API or a prefix", p)
			}
		}
	}
}

func noComments(s string) string {
	var b strings.Builder
	for _, l := range strings.Split(s, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(l), "#") {
			b.WriteString(l + "\n")
		}
	}
	return b.String()
}

func repoWith(t *testing.T, modes, compose string) string {
	t.Helper()
	repo := t.TempDir()
	write := func(p, s string) {
		_ = os.MkdirAll(filepath.Dir(filepath.Join(repo, p)), 0o755)
		if err := os.WriteFile(filepath.Join(repo, p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("stack/modes.yml", modes)
	write("e/compose.yml", `services:
  edge:
    image: traefik:v3@sha256:`+strings.Repeat("a", 64)+`
    command:
      - --providers.docker=true
      - --providers.file.directory=/etc/traefik/dynamic
      - --entrypoints.web.address=:80
      - --entrypoints.metrics.address=:8899
      - --api=true
      - --ping=true
      - --ping.entrypoint=metrics
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./dynamic:/etc/traefik/dynamic:ro
    deploy: {resources: {limits: {memory: 32m}}}
`)
	write("m/compose.yml", compose)
	return repo
}

const edgeModes = `schema: 1
modes:
  t:
    title: T
    project: p
    reserve_mib: 1
    edge: {service: edge, dir: edge/dynamic}
    modules:
      - name: e
        compose: e/compose.yml
        services: [edge]
        overrides:
          edge:
            command_remove: ["--providers.docker"]
            replace: [{from: "--entrypoints.metrics.address=:8899", to: "--entrypoints.metrics.address=127.0.0.1:8899"}]
            volumes_remove: [/var/run/docker.sock]
      - name: m
        compose: m/compose.yml
        services: [app]
    publish: [{service: edge, container: 80, env: P, default: 80}]
`

func appCompose(labels string) string {
	return `services:
  app:
    image: reg/app:1@sha256:` + strings.Repeat("b", 64) + `
    deploy: {resources: {limits: {memory: 32m}}}
    labels:
` + labels
}

// A made-up service added through modes.yml and its labels produces its router;
// no Go changes. This is the "adding a module needs no edge code" claim.
func TestNewServiceGetsItsRouterFromLabelsOnly(t *testing.T) {
	repo := repoWith(t, edgeModes, appCompose(`      - traefik.enable=true
      - traefik.http.services.app.loadbalancer.server.port=9000
      - traefik.http.routers.app-api.rule=Path(`+"`/-/api/app/x`"+`) || Path(`+"`/-/api/app/y`"+`)
      - traefik.http.routers.app-api.priority=100
      - traefik.http.routers.app-api.entrypoints=web
      - traefik.http.routers.app-api.service=app
      - traefik.http.routers.app-api.middlewares=strip
      - traefik.http.middlewares.strip.stripPrefix.prefixes=/-/api/app
`))
	out, err := Generate(repo)
	if err != nil {
		t.Fatal(err)
	}
	r := string(out["stack/t/files/edge/dynamic/routes.yml"])
	for _, must := range []string{"app-api:", "http://app:9000", "Path(`/-/api/app/x`) || Path(`/-/api/app/y`)", "priority: 100", "stripPrefix:", "- /-/api/app"} {
		if !strings.Contains(r, must) {
			t.Errorf("routes lack %q:\n%s", must, r)
		}
	}
	c := string(out["stack/t/compose.yml.tmpl"])
	if strings.Contains(c, "docker.sock") || strings.Contains(c, "providers.docker") || strings.Contains(c, "traefik.http") {
		t.Errorf("compose still has docker provider bits or labels:\n%s", c)
	}
}

func TestEdgeRefusals(t *testing.T) {
	cases := map[string]struct{ labels, want string }{
		"host rule": {"      - traefik.enable=true\n      - traefik.http.services.app.loadbalancer.server.port=1\n      - traefik.http.routers.a.rule=Host(`x.test`)\n      - traefik.http.routers.a.priority=10\n      - traefik.http.routers.a.entrypoints=web\n      - traefik.http.routers.a.service=app\n", "Host rule"},
		"prefix not catch-all": {"      - traefik.enable=true\n      - traefik.http.services.app.loadbalancer.server.port=1\n      - traefik.http.routers.a.rule=PathPrefix(`/x`)\n      - traefik.http.routers.a.priority=10\n      - traefik.http.routers.a.entrypoints=web\n      - traefik.http.routers.a.service=app\n", "not an exact Path()"},
		"catch-all with priority": {"      - traefik.enable=true\n      - traefik.http.services.app.loadbalancer.server.port=1\n      - traefik.http.routers.a.rule=PathPrefix(`/`)\n      - traefik.http.routers.a.priority=50\n      - traefik.http.routers.a.entrypoints=web\n      - traefik.http.routers.a.service=app\n", "priority 1"},
		"unknown entrypoint": {"      - traefik.enable=true\n      - traefik.http.services.app.loadbalancer.server.port=1\n      - traefik.http.routers.a.rule=Path(`/x`)\n      - traefik.http.routers.a.priority=10\n      - traefik.http.routers.a.entrypoints=sandbox\n      - traefik.http.routers.a.service=app\n", "does not exist"},
		"no entrypoints": {"      - traefik.enable=true\n      - traefik.http.services.app.loadbalancer.server.port=1\n      - traefik.http.routers.a.rule=Path(`/x`)\n      - traefik.http.routers.a.priority=10\n      - traefik.http.routers.a.service=app\n", "entrypoints"},
		"api router": {"      - traefik.enable=true\n      - traefik.http.routers.a.rule=Path(`/x`)\n      - traefik.http.routers.a.priority=10\n      - traefik.http.routers.a.entrypoints=web\n      - traefik.http.routers.a.service=api@internal\n", "api@internal"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Generate(repoWith(t, edgeModes, appCompose(c.labels)))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want error with %q, got %v", c.want, err)
			}
		})
	}
	// labels of a service with traefik.enable=false are inert
	out, err := Generate(repoWith(t, edgeModes, appCompose("      - traefik.enable=false\n      - traefik.http.routers.a.rule=Host(`x`)\n")))
	if err != nil {
		t.Fatalf("inert labels must not fail: %v", err)
	}
	if strings.Contains(noComments(string(out["stack/t/files/edge/dynamic/routes.yml"])), "Host") {
		t.Error("an inert router leaked into the config")
	}
}

func TestEdgeStaticRefusals(t *testing.T) {
	// the docker provider left in place
	bad := strings.Replace(edgeModes, `command_remove: ["--providers.docker"]`, `command_remove: ["--entrypoints.metrics"]`, 1)
	if _, err := Generate(repoWith(t, bad, appCompose("      - x=y\n"))); err == nil {
		t.Error("docker provider left in the edge must fail")
	}
	// a socket that survives (not removed by the override)
	bad = strings.Replace(edgeModes, `volumes_remove: [/var/run/docker.sock]`, `volumes_remove: []`, 1)
	if _, err := Generate(repoWith(t, bad, appCompose("      - x=y\n"))); err == nil {
		t.Error("a docker.sock mount must fail")
	}
	// an unpublished, non-loopback entrypoint (metrics left as :8899)
	bad = strings.Replace(edgeModes, `replace: [{from: "--entrypoints.metrics.address=:8899", to: "--entrypoints.metrics.address=127.0.0.1:8899"}]`, ``, 1)
	_, err := Generate(repoWith(t, bad, appCompose("      - x=y\n")))
	if err == nil || !strings.Contains(err.Error(), "no host port is published") {
		t.Errorf("an unpublished entrypoint must fail, got %v", err)
	}
	// a stale override is an error
	bad = strings.Replace(edgeModes, `command_remove: ["--providers.docker"]`, `command_remove: ["--providers.docker", "--nothing-like-this"]`, 1)
	if _, err := Generate(repoWith(t, bad, appCompose("      - x=y\n"))); err == nil || !strings.Contains(err.Error(), "matches nothing") {
		t.Errorf("a stale override must fail, got %v", err)
	}
}
