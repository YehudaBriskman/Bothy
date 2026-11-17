package stackgen

import (
	"fmt"
	"sort"
	"strings"
)

// Override is how stack/modes.yml adjusts one repo service for an installed
// box. The repo's compose files are written for a checkout (a docker socket,
// ../.. bind mounts, a Prometheus on the same network); an installed box has
// none of that, and the fix belongs in data, not in Go.
//
// Every "remove" must match something: an override that does nothing means the
// repo's compose file moved and the override is stale, which is a generate-time
// error rather than a silent leak.
type Override struct {
	CommandRemove []string     `yaml:"command_remove"` // drop command items with these prefixes
	CommandAdd    []string     `yaml:"command_add"`
	Replace       []ReplaceRow `yaml:"replace"` // exact item -> item, in command and healthcheck.test
	VolumesRemove []string     `yaml:"volumes_remove"` // by container path (the target)
	VolumesAdd    []string     `yaml:"volumes_add"`
	TmpfsAdd      []string     `yaml:"tmpfs_add"`
	EnvRemove     []string     `yaml:"env_remove"`
	DropKeys      []string     `yaml:"drop_keys"` // whole compose keys (extra_hosts, ...)
	LabelsRemove  []string     `yaml:"labels_remove"` // by key prefix
	LabelsSet     []string     `yaml:"labels_set"`    // key=value; replaces the key, or adds it
}

type ReplaceRow struct {
	From string `yaml:"from"`
	To   string `yaml:"to"`
}

func strList(v any) []string {
	var out []string
	switch t := v.(type) {
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	case []string:
		out = append(out, t...)
	}
	return out
}

func toAny(ss []string) []any {
	out := make([]any, 0, len(ss))
	for _, s := range ss {
		out = append(out, s)
	}
	return out
}

// labelList reads compose labels in either form, as sorted-stable "k=v" strings.
func labelList(v any) []string {
	switch t := v.(type) {
	case []any:
		return strList(t)
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var out []string
		for _, k := range keys {
			out = append(out, fmt.Sprintf("%s=%v", k, t[k]))
		}
		return out
	}
	return nil
}

func labelKey(l string) string {
	if i := strings.Index(l, "="); i >= 0 {
		return l[:i]
	}
	return l
}

// volTarget is the container path of a short-form volume. The SOURCE may itself
// contain colons (`${NOTES_ROOT:-${HOME}/notes}:/repos/notes:rw`), so it reads
// from the right: an optional trailing mode, then the target.
func volTarget(v string) string {
	f := strings.Split(v, ":")
	if n := len(f); n >= 3 {
		switch f[n-1] {
		case "ro", "rw", "z", "Z", "nocopy":
			f = f[:n-1]
		}
	}
	return f[len(f)-1]
}

func applyOverride(in map[string]any, ov Override) (map[string]any, error) {
	def := map[string]any{}
	for k, v := range in {
		def[k] = v
	}
	// command
	if len(ov.CommandRemove)+len(ov.CommandAdd)+len(ov.Replace) > 0 {
		cmd := strList(def["command"])
		var nc []string
		for _, pre := range ov.CommandRemove {
			hit := false
			for _, c := range cmd {
				hit = hit || strings.HasPrefix(c, pre)
			}
			if !hit {
				return nil, fmt.Errorf("command_remove %q matches nothing (the repo's compose file moved?)", pre)
			}
		}
	next:
		for _, c := range cmd {
			for _, pre := range ov.CommandRemove {
				if strings.HasPrefix(c, pre) {
					continue next
				}
			}
			nc = append(nc, c)
		}
		for _, r := range ov.Replace {
			hit := false
			for i := range nc {
				if nc[i] == r.From {
					nc[i], hit = r.To, true
				}
			}
			if hc, ok := def["healthcheck"].(map[string]any); ok {
				ht := strList(hc["test"])
				hh := false
				for i := range ht {
					if ht[i] == r.From {
						ht[i], hh = r.To, true
					}
				}
				if hh {
					nh := map[string]any{}
					for k, v := range hc {
						nh[k] = v
					}
					nh["test"] = toAny(ht)
					def["healthcheck"] = nh
					hit = true
				}
			}
			if !hit {
				return nil, fmt.Errorf("replace %q matches nothing", r.From)
			}
		}
		nc = append(nc, ov.CommandAdd...)
		def["command"] = toAny(nc)
	}
	// volumes
	if len(ov.VolumesRemove)+len(ov.VolumesAdd) > 0 {
		var nv []any
		removed := map[string]bool{}
		if vols, ok := def["volumes"].([]any); ok {
		vl:
			for _, v := range vols {
				if vs, ok := v.(string); ok {
					tgt := volTarget(vs)
					for _, t := range ov.VolumesRemove {
						if tgt == t {
							removed[t] = true
							continue vl
						}
					}
				}
				nv = append(nv, v)
			}
		}
		for _, t := range ov.VolumesRemove {
			if !removed[t] {
				return nil, fmt.Errorf("volumes_remove %q matches no mount", t)
			}
		}
		for _, a := range ov.VolumesAdd {
			nv = append(nv, a)
		}
		def["volumes"] = nv
	}
	if len(ov.TmpfsAdd) > 0 {
		def["tmpfs"] = toAny(append(strList(def["tmpfs"]), ov.TmpfsAdd...))
	}
	// environment (map or list form)
	if len(ov.EnvRemove) > 0 {
		for _, k := range ov.EnvRemove {
			switch e := def["environment"].(type) {
			case map[string]any:
				if _, ok := e[k]; !ok {
					return nil, fmt.Errorf("env_remove %q matches nothing", k)
				}
				ne := map[string]any{}
				for kk, vv := range e {
					if kk != k {
						ne[kk] = vv
					}
				}
				if len(ne) == 0 {
					delete(def, "environment")
				} else {
					def["environment"] = ne
				}
			case []any:
				var ne []any
				hit := false
				for _, x := range e {
					if s, _ := x.(string); labelKey(s) == k {
						hit = true
						continue
					}
					ne = append(ne, x)
				}
				if !hit {
					return nil, fmt.Errorf("env_remove %q matches nothing", k)
				}
				def["environment"] = ne
			default:
				return nil, fmt.Errorf("env_remove %q: the service has no environment", k)
			}
		}
	}
	for _, k := range ov.DropKeys {
		if _, ok := def[k]; !ok {
			return nil, fmt.Errorf("drop_keys %q matches nothing", k)
		}
		delete(def, k)
	}
	// labels
	if len(ov.LabelsRemove)+len(ov.LabelsSet) > 0 {
		ls := labelList(def["labels"])
		for _, pre := range ov.LabelsRemove {
			var nl []string
			hit := false
			for _, l := range ls {
				if strings.HasPrefix(l, pre) {
					hit = true
					continue
				}
				nl = append(nl, l)
			}
			if !hit {
				return nil, fmt.Errorf("labels_remove %q matches nothing", pre)
			}
			ls = nl
		}
		for _, set := range ov.LabelsSet {
			k := labelKey(set)
			var nl []string
			for _, l := range ls {
				if labelKey(l) != k {
					nl = append(nl, l)
				}
			}
			ls = append(nl, set)
		}
		def["labels"] = toAny(ls)
	}
	return def, nil
}
