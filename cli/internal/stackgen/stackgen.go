// Package stackgen turns stack/modes.yml and the repo's own compose files into
// the stack definition embedded in the binary (internal/install/stack/). It is a
// package, not only a main, so a test can regenerate in memory and compare with
// the committed copy: that is the drift check, and it needs no git.
//
// The transform is generic. Nothing here names a service: which services a mode
// runs, which ports it publishes and what it may bind-mount are data in
// stack/modes.yml. What the generator does to every selected service:
//
//   - build:, pull_policy: and container_name: are removed; the image becomes
//     ${BOTHY_IMAGE_<NAME>}, which the installer fills from the release manifest
//     (a digest, always);
//   - published ports are replaced by exactly the ones modes.yml lists, bound to
//     ${BOTHY_BIND};
//   - a bind mount must be an allow-listed absolute path or a relative path, which
//     becomes ./<service>/<path> under the install root; anything else is an error;
//   - networks used by fewer than two selected services are dropped, and the
//     kept ones stop being `external` and get a `bothy-` name.
package stackgen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Modes is stack/modes.yml.
type Modes struct {
	Schema int             `yaml:"schema"`
	Modes  map[string]Mode `yaml:"modes"`
}

type Mode struct {
	Title      string       `yaml:"title"`
	Project    string       `yaml:"project"`
	ReserveMiB int          `yaml:"reserve_mib"`
	Modules    []Module     `yaml:"modules"`
	Publish    []PublishRow `yaml:"publish"`
	AllowBinds []string     `yaml:"allow_binds"`
	Files      []FileRow    `yaml:"files"`
	Verify     VerifySpec   `yaml:"verify"`
}

type Module struct {
	Name     string   `yaml:"name"`
	Compose  string   `yaml:"compose"`
	Services []string `yaml:"services"`
}

type PublishRow struct {
	Service   string `yaml:"service" json:"service"`
	Container int    `yaml:"container" json:"container"`
	Env       string `yaml:"env" json:"env"`
	Default   int    `yaml:"default" json:"default"`
}

type FileRow struct {
	From string `yaml:"from"`
	To   string `yaml:"to"`
}

type VerifySpec struct {
	VersionPath string     `yaml:"version_path" json:"version_path"`
	VersionKey  string     `yaml:"version_key" json:"version_key"`
	Bytes       []BytesRow `yaml:"bytes" json:"bytes"`
}

type BytesRow struct {
	Path    string `yaml:"path" json:"path"`
	Service string `yaml:"service" json:"service"`
	File    string `yaml:"file" json:"file"`
}

// Meta is stack.json: what the installer needs to know about a generated stack
// without parsing compose.
type Meta struct {
	Schema     int          `json:"schema"`
	Mode       string       `json:"mode"`
	Title      string       `json:"title"`
	Project    string       `json:"project"`
	ReserveMiB int          `json:"reserve_mib"`
	Services   []Service    `json:"services"`
	Publish    []PublishRow `json:"publish"`
	Mkdirs     []string     `json:"mkdirs"`
	Files      []string     `json:"files"`
	Networks   []string     `json:"networks"`
	Verify     VerifySpec   `json:"verify"`
}

type Service struct {
	Name     string `json:"name"`
	ImageKey string `json:"image_key"` // the key in the release manifest
	ImageVar string `json:"image_var"` // the compose variable the installer sets
	Own      bool   `json:"own"`       // true: manifest.images; false: manifest.third_party
	MemMiB   int    `json:"mem_mib"`
}

var memRe = regexp.MustCompile(`^(\d+)([kKmMgG]?)[bB]?$`)

// MemMiB parses a compose memory limit ("64m", "1g") into MiB (rounded up).
func MemMiB(s string) (int, error) {
	m := memRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, fmt.Errorf("cannot read memory limit %q", s)
	}
	n, _ := strconv.Atoi(m[1])
	switch strings.ToLower(m[2]) {
	case "k":
		return (n + 1023) / 1024, nil
	case "g":
		return n * 1024, nil
	case "m":
		return n, nil
	}
	return (n + 1<<20 - 1) >> 20, nil
}

// ImageKey is the release-manifest name of an image reference in a compose file:
// the last path segment without tag or digest.
func ImageKey(ref string) string {
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	seg := ref[strings.LastIndex(ref, "/")+1:]
	if i := strings.Index(seg, ":"); i >= 0 {
		seg = seg[:i]
	}
	return seg
}

// ImageVar is the compose variable for an image key.
func ImageVar(key string) string {
	return "BOTHY_IMAGE_" + strings.ToUpper(strings.NewReplacer("-", "_", ".", "_").Replace(key))
}

// Generate renders every mode under repo/stack/modes.yml. The result maps a
// path (relative to the embed root, slash-separated) to its bytes.
func Generate(repo string) (map[string][]byte, error) {
	raw, err := os.ReadFile(filepath.Join(repo, "stack", "modes.yml"))
	if err != nil {
		return nil, err
	}
	var ms Modes
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&ms); err != nil {
		return nil, fmt.Errorf("stack/modes.yml: %w", err)
	}
	if ms.Schema != 1 {
		return nil, fmt.Errorf("stack/modes.yml: schema %d, want 1", ms.Schema)
	}
	out := map[string][]byte{}
	names := make([]string, 0, len(ms.Modes))
	for n := range ms.Modes {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := genMode(repo, name, ms.Modes[name], out); err != nil {
			return nil, fmt.Errorf("mode %s: %w", name, err)
		}
	}
	return out, nil
}

func genMode(repo, name string, m Mode, out map[string][]byte) error {
	if m.Project == "" || len(m.Modules) == 0 {
		return fmt.Errorf("needs a project and at least one module")
	}
	type sel struct {
		module string
		dir    string // repo-relative dir of the compose file
		def    map[string]any
	}
	selected := map[string]sel{}
	var order []string
	for _, mod := range m.Modules {
		b, err := os.ReadFile(filepath.Join(repo, mod.Compose))
		if err != nil {
			return err
		}
		var doc map[string]any
		if err := yaml.Unmarshal(b, &doc); err != nil {
			return fmt.Errorf("%s: %w", mod.Compose, err)
		}
		svcs, _ := doc["services"].(map[string]any)
		for _, s := range mod.Services {
			def, ok := svcs[s].(map[string]any)
			if !ok {
				return fmt.Errorf("%s has no service %q", mod.Compose, s)
			}
			if _, dup := selected[s]; dup {
				return fmt.Errorf("service %q selected twice", s)
			}
			selected[s] = sel{mod.Name, path.Dir(filepath.ToSlash(mod.Compose)), def}
			order = append(order, s)
		}
	}
	sort.Strings(order)

	// A network is kept only when two selected services attach to it.
	netUse := map[string]int{}
	for _, s := range order {
		for _, n := range netNames(selected[s].def["networks"]) {
			netUse[n]++
		}
	}
	keep := map[string]bool{}
	var kept []string
	for n, c := range netUse {
		if c >= 2 {
			keep[n] = true
			kept = append(kept, n)
		}
	}
	sort.Strings(kept)

	allow := map[string]bool{}
	for _, a := range m.AllowBinds {
		allow[a] = true
	}
	meta := Meta{Schema: 1, Mode: name, Title: m.Title, Project: m.Project, ReserveMiB: m.ReserveMiB,
		Publish: m.Publish, Verify: m.Verify, Mkdirs: []string{}, Files: []string{}, Networks: []string{}}
	for _, n := range kept {
		meta.Networks = append(meta.Networks, "bothy-"+n)
	}
	services := map[string]any{}
	mkdirs := map[string]bool{}
	for _, s := range order {
		d := selected[s]
		def := map[string]any{}
		for k, v := range d.def {
			def[k] = v
		}
		_, own := def["build"]
		img, _ := def["image"].(string)
		if img == "" {
			return fmt.Errorf("service %s has no image", s)
		}
		key := ImageKey(img)
		ivar := ImageVar(key)
		for _, k := range []string{"build", "container_name", "pull_policy", "ports", "networks", "volumes"} {
			delete(def, k)
		}
		def["image"] = "${" + ivar + ":?not set: run bothy install}"
		def["pull_policy"] = "never" // the installer pulls by digest first; compose never decides what to fetch

		// ports
		var ports []any
		for _, p := range m.Publish {
			if p.Service == s {
				ports = append(ports, fmt.Sprintf("${BOTHY_BIND:-127.0.0.1}:${%s:-%d}:%d", p.Env, p.Default, p.Container))
			}
		}
		if len(ports) > 0 {
			def["ports"] = ports
		}
		// networks
		var nets []any
		for _, n := range netNames(d.def["networks"]) {
			if keep[n] {
				nets = append(nets, "bothy-"+n)
			}
		}
		if len(nets) > 0 {
			def["networks"] = nets
		}
		// volumes
		if vols, ok := d.def["volumes"].([]any); ok {
			var nv []any
			for _, v := range vols {
				vs, ok := v.(string)
				if !ok {
					return fmt.Errorf("service %s: only short-form volumes are supported", s)
				}
				parts := strings.SplitN(vs, ":", 3)
				if len(parts) < 2 {
					return fmt.Errorf("service %s: volume %q has no target", s, vs)
				}
				src := parts[0]
				switch {
				case allow[src]:
				case strings.HasPrefix(src, "./") && !strings.Contains(src, ".."):
					rel := path.Join(s, strings.TrimPrefix(src, "./"))
					mkdirs[rel] = true
					parts[0] = "./" + rel
				case !strings.ContainsAny(src, "/.$"):
					return fmt.Errorf("service %s: named volume %q is not supported yet", s, src)
				default:
					return fmt.Errorf("service %s mounts %q, which an installed box does not have; allow it in stack/modes.yml or drop the service from this mode", s, src)
				}
				nv = append(nv, strings.Join(parts, ":"))
			}
			if len(nv) > 0 {
				def["volumes"] = nv
			}
		}
		// network names inside commands (traefik's --providers.docker.network=devnet)
		if cmd, ok := def["command"].([]any); ok {
			var nc []any
			for _, c := range cmd {
				cs, _ := c.(string)
				for n := range keep {
					if strings.HasSuffix(cs, "="+n) {
						cs = strings.TrimSuffix(cs, n) + "bothy-" + n
					}
				}
				nc = append(nc, cs)
			}
			def["command"] = nc
		}
		mem := 0
		if dep, ok := def["deploy"].(map[string]any); ok {
			if r, ok := dep["resources"].(map[string]any); ok {
				if l, ok := r["limits"].(map[string]any); ok {
					if ms, ok := l["memory"].(string); ok {
						v, err := MemMiB(ms)
						if err != nil {
							return fmt.Errorf("service %s: %w", s, err)
						}
						mem = v
					}
				}
			}
		}
		if mem == 0 {
			return fmt.Errorf("service %s has no memory limit; every Bothy container must have one", s)
		}
		services[s] = def
		meta.Services = append(meta.Services, Service{Name: s, ImageKey: key, ImageVar: ivar, Own: own, MemMiB: mem})
	}
	for _, p := range m.Publish {
		if _, ok := services[p.Service]; !ok {
			return fmt.Errorf("publish names unknown service %q", p.Service)
		}
	}
	// static files
	for _, f := range m.Files {
		to := path.Clean(f.To)
		if strings.HasPrefix(to, "..") || path.IsAbs(to) {
			return fmt.Errorf("file target %q escapes the stack directory", f.To)
		}
		b, err := os.ReadFile(filepath.Join(repo, f.From))
		if err != nil {
			return err
		}
		out["stack/"+name+"/files/"+to] = b
		meta.Files = append(meta.Files, to)
		mkdirs[path.Dir(to)] = true
	}
	for d := range mkdirs {
		if d != "." {
			meta.Mkdirs = append(meta.Mkdirs, d)
		}
	}
	sort.Strings(meta.Mkdirs)
	sort.Strings(meta.Files)

	networks := map[string]any{}
	for _, n := range kept {
		networks["bothy-"+n] = map[string]any{"name": "bothy-" + n}
	}
	doc := map[string]any{"name": m.Project, "services": services}
	if len(networks) > 0 {
		doc["networks"] = networks
	}
	var buf bytes.Buffer
	buf.WriteString("# GENERATED by cli/cmd/stackgen from stack/modes.yml and the repo's compose files.\n")
	buf.WriteString("# Do not edit: run `go generate ./...` in cli/. Mode: " + name + ".\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return err
	}
	out["stack/"+name+"/compose.yml.tmpl"] = buf.Bytes()
	mj, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	out["stack/"+name+"/stack.json"] = append(mj, '\n')
	return nil
}

func netNames(v any) []string {
	var out []string
	switch t := v.(type) {
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	case map[string]any:
		for k := range t {
			out = append(out, k)
		}
		sort.Strings(out)
	}
	return out
}
