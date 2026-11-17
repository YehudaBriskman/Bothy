package stackgen

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// The installed edge: Traefik with the FILE provider only.
//
// The repo's modules declare their routes once, as ordinary Traefik labels in
// their compose files (the docker provider reads them live on the dev box).
// An installed box must not mount /var/run/docker.sock into the most exposed
// process, so here the same labels are rendered at generate time into a
// file-provider config, and the labels are dropped from the generated compose.
// A module therefore needs no edge code: adding one is a services row in
// stack/modes.yml and its labels.
//
// The security rules of the live edge (edge/compose.yml, edge/dynamic/*.yml)
// are enforced here as generate-time errors, so a module cannot ship around
// them: no Host() rule (the name layer is retired; a Host rule registers and
// then matches nothing, forever), exact Path() routers plus one priority-1
// PathPrefix(`/`) catch-all, API on but never the dashboard or `api.insecure`,
// and nothing listening on an unpublished port except loopback.

func edgeFile(e *EdgeSpec) string {
	if e.File != "" {
		return e.File
	}
	return "routes.yml"
}

var (
	exactRuleRe = regexp.MustCompile("^Path\\(`[^`]+`\\)( \\|\\| Path\\(`[^`]+`\\))*$")
	hostRuleRe  = regexp.MustCompile(`(?i)host(regexp|sni)?\s*\(`)
	epRe        = regexp.MustCompile(`^--entrypoints\.([A-Za-z0-9_-]+)\.address=(.*)$`)
)

// slice-valued keys in labels are comma lists (Traefik's own label rule).
var sliceKeys = map[string]bool{"entrypoints": true, "middlewares": true, "prefixes": true}

func genEdge(m Mode, defs map[string]map[string]any, services map[string]any) ([]byte, error) {
	e := m.Edge
	if e.Service == "" || e.Dir == "" {
		return nil, fmt.Errorf("edge needs a service and a dir")
	}
	edge, ok := services[e.Service].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("edge service %q is not in this mode", e.Service)
	}
	entry, err := lintEdgeStatic(m, e, edge)
	if err != nil {
		return nil, err
	}

	routers := map[string]any{}
	svcs := map[string]any{}
	mws := map[string]any{}
	owner := map[string]string{}
	names := make([]string, 0, len(defs))
	for n := range defs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, sn := range names {
		labels := labelList(defs[sn]["labels"])
		enabled := false
		for _, l := range labels {
			if strings.EqualFold(l, "traefik.enable=true") {
				enabled = true
			}
		}
		for _, l := range labels {
			k := labelKey(l)
			if !strings.HasPrefix(k, "traefik.") || strings.EqualFold(k, "traefik.enable") {
				continue
			}
			if !enabled {
				continue // traefik.enable=false (or absent): the labels are inert, as they are on the dev box
			}
			val := strings.TrimPrefix(l, k+"=")
			parts := strings.Split(k, ".")
			if len(parts) < 5 || parts[1] != "http" {
				return nil, fmt.Errorf("service %s: label %q: only traefik.http.<routers|services|middlewares>.<name>.<field> is supported", sn, k)
			}
			kind, name, rest := parts[2], parts[3], parts[4:]
			id := kind + "/" + name
			if o, dup := owner[id]; dup && o != sn {
				return nil, fmt.Errorf("%s %q is declared by both %s and %s", kind, name, o, sn)
			}
			owner[id] = sn
			switch kind {
			case "routers":
				if err := setRouter(routers, name, rest, val); err != nil {
					return nil, fmt.Errorf("service %s: label %s: %w", sn, k, err)
				}
			case "services":
				if strings.Join(rest, ".") != "loadbalancer.server.port" {
					return nil, fmt.Errorf("service %s: label %s: only loadbalancer.server.port is supported", sn, k)
				}
				port, err := strconv.Atoi(val)
				if err != nil || port < 1 || port > 65535 {
					return nil, fmt.Errorf("service %s: label %s: %q is not a port", sn, k, val)
				}
				svcs[name] = map[string]any{"loadBalancer": map[string]any{"servers": []any{
					map[string]any{"url": fmt.Sprintf("http://%s:%d", sn, port)}}}}
			case "middlewares":
				setNested(mws, append([]string{name}, rest...), val)
			default:
				return nil, fmt.Errorf("service %s: label %s: unknown kind %q", sn, k, kind)
			}
		}
	}

	// Lint what was built.
	rnames := make([]string, 0, len(routers))
	for n := range routers {
		rnames = append(rnames, n)
	}
	sort.Strings(rnames)
	for _, n := range rnames {
		r := routers[n].(map[string]any)
		rule, _ := r["rule"].(string)
		rule = strings.Join(strings.Fields(rule), " ")
		prio, _ := r["priority"].(int)
		switch {
		case rule == "":
			return nil, fmt.Errorf("router %s has no rule", n)
		case hostRuleRe.MatchString(rule):
			return nil, fmt.Errorf("router %s: %q uses a Host rule; the name layer is retired (a Host rule matches nothing, forever). Use an exact Path() rule", n, rule)
		case rule == "PathPrefix(`/`)":
			if prio != 1 {
				return nil, fmt.Errorf("router %s: the catch-all PathPrefix(`/`) must have priority 1, not %d", n, prio)
			}
		case exactRuleRe.MatchString(rule):
			if prio < 2 {
				return nil, fmt.Errorf("router %s: an exact Path() router needs priority >= 2 (1 is the catch-all's)", n)
			}
		default:
			return nil, fmt.Errorf("router %s: rule %q is not an exact Path() rule or the priority-1 catch-all", n, rule)
		}
		if _, ok := r["priority"]; !ok {
			return nil, fmt.Errorf("router %s: set an explicit priority", n)
		}
		ep, _ := r["entryPoints"].([]any)
		if len(ep) == 0 {
			return nil, fmt.Errorf("router %s: name its entrypoints (it would otherwise listen on all of them)", n)
		}
		for _, x := range ep {
			if !entry[x.(string)] {
				return nil, fmt.Errorf("router %s: entrypoint %q does not exist in this mode (the edge declares: %s)", n, x, strings.Join(sortedSet(entry), ", "))
			}
		}
		svc, _ := r["service"].(string)
		if svc == "" {
			return nil, fmt.Errorf("router %s has no service", n)
		}
		if _, ok := svcs[svc]; !ok {
			return nil, fmt.Errorf("router %s: service %q is not declared by any selected service's labels (api@internal is never routed in an installed box)", n, svc)
		}
		for _, mw := range strList(r["middlewares"]) {
			if _, ok := mws[mw]; !ok {
				return nil, fmt.Errorf("router %s: middleware %q is not declared", n, mw)
			}
		}
	}

	// The labels are now config: drop them from the generated compose.
	for _, sn := range names {
		def, ok := services[sn].(map[string]any)
		if !ok {
			continue
		}
		var keep []any
		for _, l := range labelList(def["labels"]) {
			if !strings.HasPrefix(labelKey(l), "traefik.") {
				keep = append(keep, l)
			}
		}
		if len(keep) > 0 {
			def["labels"] = keep
		} else {
			delete(def, "labels")
		}
	}

	http := map[string]any{}
	if len(routers) > 0 {
		http["routers"] = routers
	}
	if len(svcs) > 0 {
		http["services"] = svcs
	}
	if len(mws) > 0 {
		http["middlewares"] = mws
	}
	var buf bytes.Buffer
	buf.WriteString("# GENERATED by cli/cmd/stackgen from the traefik.* labels of the selected services' compose files.\n")
	buf.WriteString("# Do not edit: declare a route in the module's compose labels (or its override in stack/modes.yml).\n")
	buf.WriteString("# No Host() rules, exact Path() routers plus one priority-1 catch-all: enforced at generate time.\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(map[string]any{"http": http}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func sortedSet(m map[string]bool) []string {
	var o []string
	for k := range m {
		o = append(o, k)
	}
	sort.Strings(o)
	return o
}

// lintEdgeStatic checks the Traefik static config the mode ends up with and
// returns the set of entrypoint names it declares.
func lintEdgeStatic(m Mode, e *EdgeSpec, edge map[string]any) (map[string]bool, error) {
	cmd := strList(edge["command"])
	entry := map[string]bool{}
	var pingEP, promEP bool
	var ping, prom, fileDir bool
	for _, c := range cmd {
		switch {
		case strings.HasPrefix(c, "--providers.") && !strings.HasPrefix(c, "--providers.file."):
			return nil, fmt.Errorf("edge %s: %q: the installed edge uses the file provider only (no docker socket)", e.Service, c)
		case strings.HasPrefix(c, "--api.dashboard"), strings.HasPrefix(c, "--api.insecure"):
			return nil, fmt.Errorf("edge %s: %q: API on, dashboard off, never insecure (it served the router table with a live credential once)", e.Service, c)
		case c == "--providers.file.directory=/etc/traefik/dynamic":
			fileDir = true
		case c == "--ping=true":
			ping = true
		case strings.HasPrefix(c, "--ping.entrypoint="):
			pingEP = true
		case c == "--metrics.prometheus=true":
			prom = true
		case strings.HasPrefix(c, "--metrics.prometheus.entryPoint="):
			promEP = true
		}
		if mm := epRe.FindStringSubmatch(c); mm != nil {
			entry[mm[1]] = true
			addr := mm[2]
			if strings.HasPrefix(addr, "127.0.0.1:") {
				continue // loopback inside the container: reachable by nothing else
			}
			port, err := strconv.Atoi(strings.TrimPrefix(addr, ":"))
			if err != nil {
				return nil, fmt.Errorf("edge %s: entrypoint %s address %q: use :PORT (published) or 127.0.0.1:PORT (internal)", e.Service, mm[1], addr)
			}
			pub := false
			for _, p := range m.Publish {
				pub = pub || (p.Service == e.Service && p.Container == port)
			}
			if !pub {
				return nil, fmt.Errorf("edge %s: entrypoint %s listens on %s but no host port is published for it; bind it to 127.0.0.1:%d or remove it", e.Service, mm[1], addr, port)
			}
		}
	}
	if !fileDir {
		return nil, fmt.Errorf("edge %s needs --providers.file.directory=/etc/traefik/dynamic", e.Service)
	}
	if (ping && !pingEP) || (prom && !promEP) {
		return nil, fmt.Errorf("edge %s: ping and metrics must name an entrypoint (left to default they open a listener of their own)", e.Service)
	}
	want := "./" + e.Dir + ":/etc/traefik/dynamic:ro"
	found := false
	for _, v := range strList(edge["volumes"]) {
		found = found || v == want
	}
	if !found {
		return nil, fmt.Errorf("edge %s must mount %s (dir %q does not match its dynamic directory)", e.Service, want, e.Dir)
	}
	return entry, nil
}

func setRouter(routers map[string]any, name string, rest []string, val string) error {
	if len(rest) != 1 {
		return fmt.Errorf("unsupported router field")
	}
	r, _ := routers[name].(map[string]any)
	if r == nil {
		r = map[string]any{}
		routers[name] = r
	}
	switch strings.ToLower(rest[0]) {
	case "rule", "service":
		r[strings.ToLower(rest[0])] = val
	case "priority":
		n, err := strconv.Atoi(val)
		if err != nil {
			return fmt.Errorf("priority %q is not a number", val)
		}
		r["priority"] = n
	case "entrypoints":
		r["entryPoints"] = splitList(val)
	case "middlewares":
		r["middlewares"] = splitList(val)
	default:
		return fmt.Errorf("router field %q is not supported (tls, observability and the rest need a deliberate decision)", rest[0])
	}
	return nil
}

func splitList(v string) []any {
	var out []any
	for _, x := range strings.Split(v, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

// setNested stores a label value at path, keeping the key case as written
// (Traefik reads label keys case-insensitively). Values under a *headers key
// stay strings; slice keys become lists; numbers and booleans are typed.
func setNested(root map[string]any, path []string, val string) {
	cur := root
	for _, p := range path[:len(path)-1] {
		nx, _ := cur[p].(map[string]any)
		if nx == nil {
			nx = map[string]any{}
			cur[p] = nx
		}
		cur = nx
	}
	last := path[len(path)-1]
	inHeaders := false
	for _, p := range path[1 : len(path)-1] {
		if strings.HasSuffix(strings.ToLower(p), "headers") {
			inHeaders = true
		}
	}
	switch {
	case sliceKeys[strings.ToLower(last)]:
		cur[last] = splitList(val)
	case inHeaders:
		cur[last] = val
	default:
		if n, err := strconv.Atoi(val); err == nil {
			cur[last] = n
		} else if val == "true" || val == "false" {
			cur[last] = val == "true"
		} else {
			cur[last] = val
		}
	}
}

// lintStack holds for every mode, edge or not: nothing generated may hand a
// container the Docker socket or the host.
func lintStack(services map[string]any) error {
	for n, v := range services {
		b, _ := json.Marshal(v)
		s := string(b)
		if strings.Contains(s, "docker.sock") {
			return fmt.Errorf("service %s mounts or references the Docker socket; an installed box never hands it to a container (it is root on the machine)", n)
		}
		def, _ := v.(map[string]any)
		if def["privileged"] == true || def["network_mode"] == "host" || def["pid"] == "host" {
			return fmt.Errorf("service %s asks for privileged, host network or host pid", n)
		}
	}
	return nil
}
