package stackgen

import (
	"bytes"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

var moduleNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,40}$`)

// Parse reads and validates the bytes of a modes.yml. A schema this binary does
// not know is refused in BOTH directions: an older file has no module catalogue,
// and a newer one may mean something these rules do not.
func Parse(raw []byte) (*Modes, error) {
	var head struct {
		Schema int `yaml:"schema"`
	}
	if err := yaml.Unmarshal(raw, &head); err != nil {
		return nil, fmt.Errorf("stack/modes.yml: %w", err)
	}
	switch {
	case head.Schema > SchemaVersion:
		return nil, fmt.Errorf("stack/modes.yml: schema %d is newer than this bothy understands (%d): use a newer bothy", head.Schema, SchemaVersion)
	case head.Schema != SchemaVersion:
		return nil, fmt.Errorf("stack/modes.yml: schema %d, want %d (schema 2 added the module catalogue)", head.Schema, SchemaVersion)
	}
	var ms Modes
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&ms); err != nil {
		return nil, fmt.Errorf("stack/modes.yml: %w", err)
	}
	for n, m := range ms.Modules {
		m.Name = n
		ms.Modules[n] = m
	}
	if err := ms.validate(); err != nil {
		return nil, fmt.Errorf("stack/modes.yml: %w", err)
	}
	return &ms, nil
}

// Load reads stack/modes.yml from a repo-shaped file system.
func Load(fsys fs.FS) (*Modes, error) {
	raw, err := fs.ReadFile(fsys, "stack/modes.yml")
	if err != nil {
		return nil, err
	}
	return Parse(raw)
}

func (ms *Modes) validate() error {
	if len(ms.Modes) == 0 || len(ms.Modules) == 0 {
		return fmt.Errorf("needs at least one mode and one module")
	}
	provider := map[string]string{} // capability -> module that provides it
	for _, n := range ms.ModuleNames() {
		m := ms.Modules[n]
		if !moduleNameRe.MatchString(n) {
			return fmt.Errorf("module name %q: lower case letters, digits and '-', starting with a letter", n)
		}
		if m.Compose == "" || len(m.Services) == 0 {
			return fmt.Errorf("module %s needs a compose file and at least one service", n)
		}
		if m.MemoryMiB <= 0 {
			return fmt.Errorf("module %s needs memory_mib (its declared memory cost)", n)
		}
		for _, mode := range m.Modes {
			if _, ok := ms.Modes[mode]; !ok {
				return fmt.Errorf("module %s: modes names %q, which is not a mode", n, mode)
			}
		}
		for _, c := range m.Provides {
			if _, isModule := ms.Modules[c]; isModule && c != n {
				return fmt.Errorf("module %s provides %q, which is the name of another module", n, c)
			}
			if o, dup := provider[c]; dup && o != n {
				// two providers of one capability are allowed (a choice), but not the same module twice
				continue
			}
			provider[c] = n
		}
	}
	// every requirement must name a module or a provided capability; no cycles
	for _, n := range ms.ModuleNames() {
		for _, r := range ms.Modules[n].Requires {
			if len(ms.candidates(r)) == 0 {
				return fmt.Errorf("module %s requires %q, which is neither a module nor provided by one", n, r)
			}
			if r == n {
				return fmt.Errorf("module %s requires itself", n)
			}
		}
	}
	for _, n := range ms.ModuleNames() {
		if cyc := ms.cycleFrom(n); cyc != "" {
			return fmt.Errorf("modules require each other in a cycle: %s", cyc)
		}
	}
	for mode, m := range ms.Modes {
		if m.Edge != nil && m.Edge.Service == "" {
			return fmt.Errorf("mode %s: edge needs a service", mode)
		}
	}
	return nil
}

func (ms *Modes) cycleFrom(start string) string {
	var walk func(n string, path []string) string
	walk = func(n string, path []string) string {
		for _, p := range path {
			if p == n {
				return strings.Join(append(path, n), " -> ")
			}
		}
		for _, r := range ms.Modules[n].Requires {
			for _, c := range ms.candidates(r) {
				if s := walk(c, append(append([]string{}, path...), n)); s != "" {
					return s
				}
			}
		}
		return ""
	}
	return walk(start, nil)
}

// ModuleNames is every module of the catalogue, sorted.
func (ms *Modes) ModuleNames() []string {
	out := make([]string, 0, len(ms.Modules))
	for n := range ms.Modules {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// candidates are the modules that can satisfy a requirement: the module of that
// name, or the modules that provide it.
func (ms *Modes) candidates(req string) []string {
	if _, ok := ms.Modules[req]; ok {
		return []string{req}
	}
	var out []string
	for _, n := range ms.ModuleNames() {
		for _, p := range ms.Modules[n].Provides {
			if p == req {
				out = append(out, n)
			}
		}
	}
	return out
}

// DefaultSet is what `bothy install --mode` installs: the modules that list the
// mode, with the core modules and everything required.
func (ms *Modes) DefaultSet(mode string) ([]string, error) {
	if _, ok := ms.Modes[mode]; !ok {
		return nil, fmt.Errorf("no mode %q", mode)
	}
	var names []string
	for _, n := range ms.ModuleNames() {
		for _, m := range ms.Modules[n].Modes {
			if m == mode {
				names = append(names, n)
			}
		}
	}
	return ms.Closure(names)
}

// Closure returns the set `names` implies: the core modules, the named modules
// and everything they require, sorted by name. A requirement that several
// modules could satisfy is satisfied by one already in the set; otherwise it is
// an error (the caller must name which one).
func (ms *Modes) Closure(names []string) ([]string, error) {
	in := map[string]bool{}
	for _, n := range ms.ModuleNames() {
		if ms.Modules[n].Core {
			in[n] = true
		}
	}
	for _, n := range names {
		if _, ok := ms.Modules[n]; !ok {
			return nil, fmt.Errorf("no module %q (have: %s)", n, strings.Join(ms.ModuleNames(), ", "))
		}
		in[n] = true
	}
	for changed := true; changed; {
		changed = false
		for _, n := range sortedKeys(in) {
			for _, r := range ms.Modules[n].Requires {
				cs := ms.candidates(r)
				if anyIn(cs, in) {
					continue
				}
				if len(cs) != 1 {
					return nil, fmt.Errorf("module %s requires %q, which %s could each provide: name one of them", n, r, strings.Join(cs, ", "))
				}
				in[cs[0]] = true
				changed = true
			}
		}
	}
	return sortedKeys(in), nil
}

func anyIn(cs []string, in map[string]bool) bool {
	for _, c := range cs {
		if in[c] {
			return true
		}
	}
	return false
}

// Unsatisfied lists "module needs requirement" for every requirement of a member
// of set that no member of set provides. A set that is not closed cannot run.
func (ms *Modes) Unsatisfied(set []string) []string {
	in := map[string]bool{}
	for _, n := range set {
		in[n] = true
	}
	var out []string
	for _, n := range sortedKeys(in) {
		for _, r := range ms.Modules[n].Requires {
			if !anyIn(ms.candidates(r), in) {
				out = append(out, n+" needs "+r)
			}
		}
	}
	return out
}

// Dependants are the members of set (other than name) that stop being satisfied
// when name leaves it.
func (ms *Modes) Dependants(set []string, name string) []string {
	var rest []string
	for _, n := range set {
		if n != name {
			rest = append(rest, n)
		}
	}
	in := map[string]bool{}
	for _, n := range rest {
		in[n] = true
	}
	var out []string
	for _, n := range sortedKeys(in) {
		for _, r := range ms.Modules[n].Requires {
			if !anyIn(ms.candidates(r), in) {
				out = append(out, n)
				break
			}
		}
	}
	return out
}
