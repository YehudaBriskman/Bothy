// Package stackgen turns stack/modes.yml and the repo's own compose files into
// the stack definition embedded in the binary (internal/install/stack/). It is a
// package, not only a main, so a test can regenerate in memory and compare with
// the committed copy: that is the drift check, and it needs no git.
//
// The transform is generic. Nothing here names a service or a module: which
// modules exist, what each costs and needs, which ports a mode publishes and
// what may be bind-mounted are data in stack/modes.yml. What the generator does
// to every selected service:
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
//
// A stack is generated for a SET of modules (GenSet). `go generate` renders each
// mode's default set, and ALSO proves that every module can be added to every
// mode; the binary embeds the sources (stack/_source) so an installed box can
// generate the set it actually runs, with `bothy module add|remove`, at run time.
package stackgen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Modes is stack/modes.yml (schema 2): the modes, and the catalogue of modules
// they are made of. A mode is only a name, a project and a default set; a
// module is the unit that is added to or removed from an installed box.
type Modes struct {
	Schema  int               `yaml:"schema"`
	Modes   map[string]Mode   `yaml:"modes"`
	Modules map[string]Module `yaml:"modules"`
}

type Mode struct {
	Title      string       `yaml:"title"`
	Project    string       `yaml:"project"`
	ReserveMiB int          `yaml:"reserve_mib"`
	Publish    []PublishRow `yaml:"publish"`
	AllowBinds []string     `yaml:"allow_binds"`
	Verify     ModeVerify   `yaml:"verify"`
	// Edge names the service that is the Traefik edge. When set, the generated
	// stack has NO docker provider and no socket: the routes every selected
	// service declares in its compose labels are rendered into a file-provider
	// config instead (edge.go), and the result is linted (no Host(), exact Path()
	// routers plus a priority-1 catch-all, no dashboard, nothing listening on an
	// unpublished port except loopback).
	Edge *EdgeSpec `yaml:"edge"`
}

// ModeVerify is the part of the bytes check that belongs to the mode: the
// release commit the edge must report.
type ModeVerify struct {
	VersionPath string `yaml:"version_path"`
	VersionKey  string `yaml:"version_key"`
}

type EdgeSpec struct {
	Service string `yaml:"service"` // the Traefik service
	Dir     string `yaml:"dir"`     // under the stack dir; the service's bound dynamic dir
	File    string `yaml:"file"`    // name of the generated file (default routes.yml)
}

// Module is one entry of the catalogue. Everything a module is, is data here
// and in its compose file: adding one needs no Go.
type Module struct {
	Name        string   `yaml:"-"` // the map key
	Description string   `yaml:"description"`
	Compose     string   `yaml:"compose"`
	Services    []string `yaml:"services"`
	// MemoryMiB is the declared memory cost. It must equal the sum of the
	// services' compose limits (checked at generate time), so the number a
	// person is shown is the number the budget gate uses.
	MemoryMiB int `yaml:"memory_mib"`
	// Requires lists module names or capabilities some module Provides.
	Requires []string `yaml:"requires"`
	Provides []string `yaml:"provides"`
	// Core modules are in every set and cannot be removed.
	Core bool `yaml:"core"`
	// Modes lists the modes that install this module by default. A module in no
	// mode is opt-in: added with `bothy module add`.
	Modes []string `yaml:"modes"`
	// Files are copied from the repo into <install root>/stack/<to>.
	Files []FileRow `yaml:"files"`
	// Health is the module's contract beyond the containers' own healthchecks.
	Health Health `yaml:"health"`
	// Overrides adjusts a repo service for an installed box (override.go). Data
	// only: a module's compose file is the repo's, written for a checkout.
	Overrides map[string]Override `yaml:"overrides"`
}

// Health: what must be true, read as BYTES (not a status code), after an apply.
type Health struct {
	Bytes []BytesRow `yaml:"bytes"` // a path served through the edge equals a file inside a service
	HTTP  []HTTPRow  `yaml:"http"`  // a path served through the edge contains this text
}

type HTTPRow struct {
	Path     string `yaml:"path" json:"path"`
	Contains string `yaml:"contains" json:"contains"`
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

// VerifySpec is what the installer checks after `up`, for the whole set.
type VerifySpec struct {
	VersionPath string     `json:"version_path"`
	VersionKey  string     `json:"version_key"`
	Bytes       []BytesRow `json:"bytes"`
	HTTP        []HTTPRow  `json:"http,omitempty"`
}

type BytesRow struct {
	Path    string `yaml:"path" json:"path"`
	Service string `yaml:"service" json:"service"`
	File    string `yaml:"file" json:"file"`
}

// SchemaVersion is the modes.yml and stack.json schema this code reads and writes.
const SchemaVersion = 2

// Meta is stack.json: what the installer needs to know about a generated stack
// without parsing compose.
type Meta struct {
	Schema     int          `json:"schema"`
	Mode       string       `json:"mode"`
	Title      string       `json:"title"`
	Project    string       `json:"project"`
	ReserveMiB int          `json:"reserve_mib"`
	Modules    []ModuleMeta `json:"modules"`
	Services   []Service    `json:"services"`
	Publish    []PublishRow `json:"publish"`
	Mkdirs     []string     `json:"mkdirs"`
	Files      []string     `json:"files"`
	Networks   []string     `json:"networks"`
	Verify     VerifySpec   `json:"verify"`
}

// ModuleMeta is one member of the generated set.
type ModuleMeta struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	MemMiB      int      `json:"mem_mib"`
	Core        bool     `json:"core,omitempty"`
	Requires    []string `json:"requires"` // as declared
	Provides    []string `json:"provides"`
	Services    []string `json:"services"`
	Files       []string `json:"files"`  // files this module owns, under the stack dir
	Mkdirs      []string `json:"mkdirs"` // directories its services bind-mount (kept on remove: they may hold data)
}

type Service struct {
	Name     string `json:"name"`
	Module   string `json:"module"`
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

// SourceDir is where Generate puts the sources the binary needs to generate a
// set at run time, under the embed root. It has the repo's layout, so it is
// itself a valid fs.FS for Load and GenSet.
const SourceDir = "stack/_source"

// Generate renders every mode's default set under repo/stack/modes.yml, and the
// sources for run-time generation. The result maps a path (relative to the embed
// root, slash-separated) to its bytes. It also proves, so a bad module fails at
// generate time and never on someone's box, that every module can be added to
// every mode's default set.
func Generate(repo string) (map[string][]byte, error) {
	fsys := os.DirFS(repo)
	ms, err := Load(fsys)
	if err != nil {
		return nil, err
	}
	out := map[string][]byte{}
	modes := make([]string, 0, len(ms.Modes))
	for n := range ms.Modes {
		modes = append(modes, n)
	}
	sort.Strings(modes)
	mods := ms.ModuleNames()
	for _, mode := range modes {
		def, err := ms.DefaultSet(mode)
		if err != nil {
			return nil, fmt.Errorf("mode %s: %w", mode, err)
		}
		set, err := GenSet(fsys, ms, mode, def)
		if err != nil {
			return nil, fmt.Errorf("mode %s: %w", mode, err)
		}
		base := "stack/" + mode + "/"
		out[base+"compose.yml.tmpl"] = set.Compose
		mj, err := json.MarshalIndent(set.Meta, "", "  ")
		if err != nil {
			return nil, err
		}
		out[base+"stack.json"] = append(mj, '\n')
		for p, b := range set.Files {
			out[base+"files/"+p] = b
		}
		for _, m := range mods {
			if _, err := GenSet(fsys, ms, mode, append(append([]string{}, def...), m)); err != nil {
				return nil, fmt.Errorf("mode %s: adding module %s: %w", mode, m, err)
			}
		}
		if _, err := GenSet(fsys, ms, mode, nil); err != nil {
			return nil, fmt.Errorf("mode %s: the core modules alone: %w", mode, err)
		}
	}
	// the sources, for run-time generation
	raw, err := fs.ReadFile(fsys, "stack/modes.yml")
	if err != nil {
		return nil, err
	}
	out[SourceDir+"/stack/modes.yml"] = raw
	// A compose file is bundled PRUNED to the services some module selects, with
	// the two things the generator reads only for their presence normalised: the
	// image (its key is all that is used, so a Dependabot pin bump does not make
	// the embedded copy stale; the installer takes the digest from the release
	// manifest) and `build`. Everything else the generator uses is kept as is.
	wanted := map[string]map[string]bool{}
	for _, m := range mods {
		mod := ms.Modules[m]
		if wanted[mod.Compose] == nil {
			wanted[mod.Compose] = map[string]bool{}
		}
		for _, s := range mod.Services {
			wanted[mod.Compose][s] = true
		}
		for _, f := range mod.Files {
			b, err := fs.ReadFile(fsys, f.From)
			if err != nil {
				return nil, err
			}
			out[SourceDir+"/"+path.Clean(f.From)] = b
		}
	}
	for p, svcs := range wanted {
		b, err := fs.ReadFile(fsys, p)
		if err != nil {
			return nil, err
		}
		var doc map[string]any
		if err := yaml.Unmarshal(b, &doc); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		all, _ := doc["services"].(map[string]any)
		keep := map[string]any{}
		for s := range svcs {
			def, ok := all[s].(map[string]any)
			if !ok {
				continue // GenSet names the missing service
			}
			nd := map[string]any{}
			for k, v := range def {
				nd[k] = v
			}
			if img, ok := nd["image"].(string); ok {
				nd["image"] = ImageKey(img)
			}
			if _, ok := nd["build"]; ok {
				nd["build"] = true
			}
			keep[s] = nd
		}
		var buf bytes.Buffer
		buf.WriteString("# GENERATED by cli/cmd/stackgen: " + p + " pruned to the services stack/modes.yml selects.\n")
		enc := yaml.NewEncoder(&buf)
		enc.SetIndent(2)
		if err := enc.Encode(map[string]any{"services": keep}); err != nil {
			return nil, err
		}
		out[SourceDir+"/"+path.Clean(p)+".src"] = buf.Bytes() // not compose*.yml: release tooling scans repo trees for those
	}
	return out, nil
}

// SetOut is one generated stack.
type SetOut struct {
	Compose []byte
	Meta    Meta
	Files   map[string][]byte // path under the stack dir -> content
}

// GenSet generates the stack of `mode` for the module set `names` (core modules
// and everything they require are added). It is pure: the same inputs give the
// same bytes.
func GenSet(fsys fs.FS, ms *Modes, mode string, names []string) (*SetOut, error) {
	m, ok := ms.Modes[mode]
	if !ok {
		return nil, fmt.Errorf("no mode %q", mode)
	}
	if m.Project == "" {
		return nil, fmt.Errorf("mode %s needs a project", mode)
	}
	set, err := ms.Closure(names)
	if err != nil {
		return nil, err
	}
	type sel struct {
		module string
		dir    string // repo-relative dir of the compose file
		def    map[string]any
	}
	selected := map[string]sel{}
	owner := map[string]string{} // service -> module
	var order []string
	docs := map[string]map[string]any{}
	for _, mn := range set {
		mod := ms.Modules[mn]
		doc, ok := docs[mod.Compose]
		if !ok {
			b, err := readCompose(fsys, mod.Compose)
			if err != nil {
				return nil, fmt.Errorf("module %s: %w", mn, err)
			}
			if err := yaml.Unmarshal(b, &doc); err != nil {
				return nil, fmt.Errorf("%s: %w", mod.Compose, err)
			}
			docs[mod.Compose] = doc
		}
		svcs, _ := doc["services"].(map[string]any)
		for _, s := range mod.Services {
			def, ok := svcs[s].(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s has no service %q", mod.Compose, s)
			}
			if _, dup := selected[s]; dup {
				return nil, fmt.Errorf("service %q selected twice", s)
			}
			if ov, ok := mod.Overrides[s]; ok {
				var oerr error
				if def, oerr = applyOverride(def, ov); oerr != nil {
					return nil, fmt.Errorf("module %s: override of %s: %w", mn, s, oerr)
				}
			}
			selected[s] = sel{mn, path.Dir(mod.Compose), def}
			owner[s] = mn
			order = append(order, s)
		}
	}
	sort.Strings(order)
	for _, mn := range set {
		for s := range ms.Modules[mn].Overrides {
			if sv, ok := selected[s]; !ok || sv.module != mn {
				return nil, fmt.Errorf("module %s: override names %q, which it does not select", mn, s)
			}
		}
	}

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
	meta := Meta{Schema: SchemaVersion, Mode: mode, Title: m.Title, Project: m.Project, ReserveMiB: m.ReserveMiB,
		Publish: m.Publish, Mkdirs: []string{}, Files: []string{}, Networks: []string{},
		Verify: VerifySpec{VersionPath: m.Verify.VersionPath, VersionKey: m.Verify.VersionKey, Bytes: []BytesRow{}}}
	for _, n := range kept {
		meta.Networks = append(meta.Networks, "bothy-"+n)
	}
	services := map[string]any{}
	mkdirs := map[string]bool{}
	modMkdirs := map[string]map[string]bool{}
	modMem := map[string]int{}
	healthy := map[string]bool{} // module -> some service carries a healthcheck
	for _, s := range order {
		d := selected[s]
		def := map[string]any{}
		for k, v := range d.def {
			def[k] = v
		}
		_, own := def["build"]
		img, _ := def["image"].(string)
		if img == "" {
			return nil, fmt.Errorf("service %s has no image", s)
		}
		key := ImageKey(img)
		ivar := ImageVar(key)
		for _, k := range []string{"build", "container_name", "pull_policy", "ports", "networks", "volumes"} {
			delete(def, k)
		}
		def["image"] = "${" + ivar + ":?not set: run bothy install}"
		def["pull_policy"] = "never" // the installer pulls by digest first; compose never decides what to fetch
		if _, ok := def["healthcheck"]; ok {
			healthy[d.module] = true
		}

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
					return nil, fmt.Errorf("service %s: only short-form volumes are supported", s)
				}
				parts := strings.SplitN(vs, ":", 3)
				if len(parts) < 2 {
					return nil, fmt.Errorf("service %s: volume %q has no target", s, vs)
				}
				src := parts[0]
				switch {
				case allow[src]:
				case strings.HasPrefix(src, "./") && !strings.Contains(src, ".."):
					rel := path.Join(s, strings.TrimPrefix(src, "./"))
					mkdirs[rel] = true
					if modMkdirs[d.module] == nil {
						modMkdirs[d.module] = map[string]bool{}
					}
					modMkdirs[d.module][rel] = true
					parts[0] = "./" + rel
				case !strings.ContainsAny(src, "/.$"):
					return nil, fmt.Errorf("service %s: named volume %q is not supported yet", s, src)
				default:
					return nil, fmt.Errorf("service %s mounts %q, which an installed box does not have; allow it in stack/modes.yml or drop the service from this mode", s, src)
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
							return nil, fmt.Errorf("service %s: %w", s, err)
						}
						mem = v
					}
				}
			}
		}
		if mem == 0 {
			return nil, fmt.Errorf("service %s has no memory limit; every Bothy container must have one", s)
		}
		modMem[d.module] += mem
		services[s] = def
		meta.Services = append(meta.Services, Service{Name: s, Module: d.module, ImageKey: key, ImageVar: ivar, Own: own, MemMiB: mem})
	}
	for _, p := range m.Publish {
		if _, ok := services[p.Service]; !ok {
			return nil, fmt.Errorf("publish names unknown service %q", p.Service)
		}
	}
	files := map[string][]byte{}
	modFiles := map[string][]string{}
	// the generated edge: file-provider routes from the services' labels
	if m.Edge != nil {
		defs := map[string]map[string]any{}
		for _, s := range order {
			defs[s] = selected[s].def
		}
		routes, err := genEdge(m, defs, services)
		if err != nil {
			return nil, err
		}
		to := path.Join(m.Edge.Dir, edgeFile(m.Edge))
		files[to] = routes
		meta.Files = append(meta.Files, to)
		mkdirs[m.Edge.Dir] = true
		eo := owner[m.Edge.Service]
		modFiles[eo] = append(modFiles[eo], to)
		if modMkdirs[eo] == nil {
			modMkdirs[eo] = map[string]bool{}
		}
		modMkdirs[eo][m.Edge.Dir] = true
	}
	if err := lintStack(services); err != nil {
		return nil, err
	}
	// static files
	for _, mn := range set {
		for _, f := range ms.Modules[mn].Files {
			to := path.Clean(f.To)
			if strings.HasPrefix(to, "..") || path.IsAbs(to) {
				return nil, fmt.Errorf("module %s: file target %q escapes the stack directory", mn, f.To)
			}
			b, err := fs.ReadFile(fsys, f.From)
			if err != nil {
				return nil, err
			}
			files[to] = b
			meta.Files = append(meta.Files, to)
			mkdirs[path.Dir(to)] = true
			modFiles[mn] = append(modFiles[mn], to)
			if modMkdirs[mn] == nil {
				modMkdirs[mn] = map[string]bool{}
			}
			modMkdirs[mn][path.Dir(to)] = true
		}
	}
	// per-module meta, and the set's bytes contract
	for _, mn := range set {
		mod := ms.Modules[mn]
		if modMem[mn] != mod.MemoryMiB {
			return nil, fmt.Errorf("module %s declares memory_mib %d but its services' limits add up to %d: the number shown to a person must be the one the budget gate uses", mn, mod.MemoryMiB, modMem[mn])
		}
		if !healthy[mn] && len(mod.Health.Bytes) == 0 && len(mod.Health.HTTP) == 0 {
			return nil, fmt.Errorf("module %s has no health contract: give one of its services a healthcheck, or declare health.http / health.bytes", mn)
		}
		mm := ModuleMeta{Name: mn, Description: mod.Description, MemMiB: mod.MemoryMiB, Core: mod.Core,
			Requires: nz(mod.Requires), Provides: nz(mod.Provides), Services: nz(mod.Services)}
		sort.Strings(modFiles[mn])
		mm.Files = nz(modFiles[mn])
		mm.Mkdirs = sortedKeys(modMkdirs[mn])
		meta.Modules = append(meta.Modules, mm)
		meta.Verify.Bytes = append(meta.Verify.Bytes, mod.Health.Bytes...)
		meta.Verify.HTTP = append(meta.Verify.HTTP, mod.Health.HTTP...)
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
	buf.WriteString("# Do not edit: run `go generate ./...` in cli/. Mode: " + mode + ". Modules: " + strings.Join(set, ", ") + ".\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return &SetOut{Compose: buf.Bytes(), Meta: meta, Files: files}, nil
}

// readCompose reads a module's compose file from the repo, or, in the embedded
// sources, its pruned copy (named <path>.src so repo-wide compose scanners skip it).
func readCompose(fsys fs.FS, p string) ([]byte, error) {
	if b, err := fs.ReadFile(fsys, p); err == nil {
		return b, nil
	}
	return fs.ReadFile(fsys, p+".src")
}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func sortedKeys(m map[string]bool) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
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
