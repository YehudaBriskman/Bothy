// Package render turns the data of a v1 response into human text, and
// sanitises it for --json. It knows the shape of each operation's data; the
// shapes are the golden files'. Server text typed `untrusted` is always shown
// sanitised and inside an explicit marker; it is never printed bare.
package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/YehudaBriskman/Bothy/cli/internal/api"
)

// Decode parses data keeping numbers as their JSON text.
func Decode(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// IsUntrusted reports whether v is an untrusted-text object and returns its parts.
func IsUntrusted(v any) (text, source string, ok bool) {
	m, isMap := v.(map[string]any)
	if !isMap || m["trust"] != "untrusted" {
		return "", "", false
	}
	t, tok := m["text"].(string)
	if !tok {
		return "", "", false
	}
	s, _ := m["source"].(string)
	return t, s, true
}

// SanitizeTree returns v with the text of every untrusted object sanitised
// (and every other string too, since a terminal or a model sees them all).
func SanitizeTree(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[api.Sanitize(k)] = SanitizeTree(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = SanitizeTree(e)
		}
		return out
	case string:
		return api.Sanitize(x)
	}
	return v
}

// JSON writes data as indented JSON with every string sanitised and the
// untrusted markers intact: what `--json` prints.
func JSON(w io.Writer, raw []byte) error {
	v, err := Decode(raw)
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(SanitizeTree(v), "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s\n", b)
	return err
}

// Untrusted formats untrusted text on one line, inside a marker that names its
// source: [untrusted container-log: "text"]. Quotes inside are escaped so the
// marker cannot be closed from within.
func Untrusted(v any) string {
	text, src, ok := IsUntrusted(v)
	if !ok {
		return scalar(v)
	}
	if src == "" {
		src = "unknown"
	}
	one := strings.Join(strings.Split(api.Sanitize(text), "\n"), " | ")
	one = strings.ReplaceAll(strings.ReplaceAll(one, "\t", " "), `"`, `\"`)
	return fmt.Sprintf("[untrusted %s: \"%s\"]", api.OneLine(src), one)
}

// scalar formats any leaf for a table cell; an untrusted object is marked.
func scalar(v any) string {
	switch x := v.(type) {
	case nil:
		return "-"
	case string:
		if x == "" {
			return "-"
		}
		return api.OneLine(x)
	case bool:
		if x {
			return "yes"
		}
		return "no"
	case json.Number:
		return x.String()
	case map[string]any:
		if _, _, ok := IsUntrusted(x); ok {
			return Untrusted(x)
		}
		b, _ := json.Marshal(SanitizeTree(x))
		return string(b)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = scalar(e)
		}
		return strings.Join(parts, ", ")
	}
	return api.OneLine(fmt.Sprint(v))
}

// reader collects missing-field problems so a renderer can fail naming them
// (golden README rule 3: fail on a field you need that is missing).
type reader struct{ missing []string }

func (r *reader) need(m map[string]any, path, k string) any {
	v, ok := m[k]
	if !ok {
		r.missing = append(r.missing, path+k)
	}
	return v
}

func (r *reader) obj(m map[string]any, path, k string) map[string]any {
	o, ok := r.need(m, path, k).(map[string]any)
	if !ok {
		if _, present := m[k]; present {
			r.missing = append(r.missing, path+k+" (not an object)")
		}
		return map[string]any{}
	}
	return o
}

func (r *reader) arr(m map[string]any, path, k string) []any {
	a, ok := r.need(m, path, k).([]any)
	if !ok {
		if _, present := m[k]; present {
			r.missing = append(r.missing, path+k+" (not a list)")
		}
		return nil
	}
	return a
}

func (r *reader) str(m map[string]any, path, k string) string {
	v := r.need(m, path, k)
	if v == nil {
		return "-"
	}
	return scalar(v)
}

func (r *reader) err() error {
	if len(r.missing) == 0 {
		return nil
	}
	return &api.ProtocolError{Msg: "missing required field(s): " + strings.Join(r.missing, ", ")}
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

func get(m map[string]any, k string) string { return scalar(m[k]) }

type out struct {
	w io.Writer
}

func (o out) f(format string, a ...any) { fmt.Fprintf(o.w, format, a...) }

func (o out) table(header []string, rows [][]string) {
	tw := tabwriter.NewWriter(o.w, 0, 8, 2, ' ', 0)
	fmt.Fprintln(tw, strings.Join(header, "\t"))
	for _, r := range rows {
		fmt.Fprintln(tw, strings.Join(r, "\t"))
	}
	tw.Flush()
}

// Human renders the data of operation opID. Unknown operations fall back to a
// generic key/value dump, so adding an operation to the catalog never leaves
// the CLI unable to show it.
func Human(w io.Writer, opID string, raw []byte) error {
	v, err := Decode(raw)
	if err != nil {
		return &api.ProtocolError{Msg: "data is not JSON: " + err.Error()}
	}
	m, ok := v.(map[string]any)
	if !ok {
		return &api.ProtocolError{Msg: "data is not an object"}
	}
	o := out{w}
	r := &reader{}
	switch opID {
	case "discover":
		discover(o, r, m)
	case "status":
		status(o, r, m)
	case "module.list":
		modules(o, r, m)
	case "update.status":
		updateStatus(o, r, m)
	case "update.plan":
		updatePlan(o, r, m)
	case "update.history":
		jobs(o, r, r.arr(m, "", "jobs"))
	case "job.get":
		job(o, r, r.obj(m, "", "job"))
	case "events.query":
		events(o, r, m)
	case "settings.get":
		settings(o, r, m)
	default:
		generic(o, m, "")
	}
	return r.err()
}

func generic(o out, m map[string]any, indent string) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch x := m[k].(type) {
		case map[string]any:
			if _, _, ok := IsUntrusted(x); ok {
				o.f("%s%s: %s\n", indent, api.OneLine(k), Untrusted(x))
				continue
			}
			o.f("%s%s:\n", indent, api.OneLine(k))
			generic(o, x, indent+"  ")
		default:
			o.f("%s%s: %s\n", indent, api.OneLine(k), scalar(x))
		}
	}
}

func discover(o out, r *reader, m map[string]any) {
	o.f("API version  %s\n", r.str(m, "", "apiVersion"))
	o.f("Min client   %s\n", get(m, "minClient"))
	ops := r.arr(m, "", "ops")
	rows := make([][]string, 0, len(ops))
	for _, e := range ops {
		op := asMap(e)
		rows = append(rows, []string{get(op, "id"), get(op, "cli"), get(op, "effect"), get(op, "role"), get(op, "path")})
	}
	o.f("\n")
	o.table([]string{"OPERATION", "COMMAND", "EFFECT", "ROLE", "PATH"}, rows)
}

func status(o out, r *reader, m map[string]any) {
	srv := r.obj(m, "", "server")
	o.f("Bothy %s (api %s)\n", r.str(srv, "server.", "version"), r.str(srv, "server.", "apiVersion"))
	u := r.obj(m, "", "updates")
	o.f("Updates    %s components, %s behind, %s to apply, %s drift, %s errors\n",
		r.str(u, "updates.", "components"), r.str(u, "updates.", "behind"), r.str(u, "updates.", "toApply"),
		r.str(u, "updates.", "drift"), r.str(u, "updates.", "errors"))
	d := r.obj(m, "", "discovery")
	freshness := "fresh"
	if b, _ := d["stale"].(bool); b {
		freshness = "STALE"
	}
	if b, _ := d["present"].(bool); !b {
		freshness = "absent"
	}
	age := ""
	if d["ageSeconds"] != nil {
		age = ", " + get(d, "ageSeconds") + " s old"
	}
	o.f("Discovery  %s%s\n", freshness, age)
	if d["hint"] != nil {
		o.f("           %s\n", get(d, "hint"))
	}
	if j, ok := m["job"].(map[string]any); ok {
		o.f("Job        %s %s %s\n", get(j, "state"), get(j, "component"), get(j, "id"))
		if j["error"] != nil {
			o.f("           error: %s\n", Untrusted(j["error"]))
		}
	} else {
		o.f("Job        none\n")
	}
	att := r.arr(m, "", "needsAttention")
	if len(att) > 0 {
		o.f("\nNeeds attention (%d)\n", len(att))
		rows := make([][]string, 0, len(att))
		for _, e := range att {
			a := asMap(e)
			rows = append(rows, []string{get(a, "component"), get(a, "kind"), Untrusted(a["detail"])})
		}
		o.table([]string{"COMPONENT", "KIND", "DETAIL"}, rows)
	}
}

func modules(o out, r *reader, m map[string]any) {
	list := r.arr(m, "", "modules")
	rows := make([][]string, 0, len(list))
	for _, e := range list {
		mod := asMap(e)
		rows = append(rows, []string{get(mod, "id"), get(mod, "runtime"), get(mod, "components"), get(mod, "recipe")})
	}
	o.table([]string{"MODULE", "RUNTIME", "COMPONENTS", "RECIPE"}, rows)
	o.f("\nsource: %s\n", get(m, "source"))
}

func updateStatus(o out, r *reader, m map[string]any) {
	s := r.obj(m, "", "summary")
	o.f("%s components, %s behind, %s to apply, %s groups, %s drift, %s errors\n",
		r.str(s, "summary.", "components"), r.str(s, "summary.", "behind"), r.str(s, "summary.", "toApply"),
		r.str(s, "summary.", "groups"), r.str(s, "summary.", "drift"), r.str(s, "summary.", "errors"))
	if a, ok := m["auto"].(map[string]any); ok {
		o.f("Night job  %s, paused: %s\n", get(a, "enabled"), get(a, "paused"))
	}
	if j, ok := m["job"].(map[string]any); ok {
		o.f("Running    %s %s %s\n", get(j, "state"), get(j, "component"), get(j, "id"))
	}
	comps := r.arr(m, "", "components")
	rows := make([][]string, 0, len(comps))
	for _, e := range comps {
		c := asMap(e)
		change, plan := "-", asMap(c["plan"])
		if plan["from"] != nil || plan["to"] != nil {
			change = get(plan, "from") + " -> " + get(plan, "to")
		}
		state := "current"
		switch {
		case c["paused"] != nil:
			state = "paused"
		case plan["deployable"] == false:
			state = "refused"
		case c["behind"] == true:
			state = "behind"
		case plan["id"] != nil:
			state = "plan ready"
		}
		rows = append(rows, []string{get(c, "id"), get(c, "class"), get(c, "channel"), change, get(plan, "level"), get(c, "group"), state})
	}
	o.f("\n")
	o.table([]string{"COMPONENT", "CLASS", "CHANNEL", "CHANGE", "LEVEL", "GROUP", "STATE"}, rows)
	for _, e := range comps {
		c := asMap(e)
		if p, ok := c["paused"].(map[string]any); ok {
			o.f("\n%s is paused: %s\n", get(c, "id"), Untrusted(p["reason"]))
		}
		if plan := asMap(c["plan"]); plan["deployable"] == false && plan["reason"] != nil {
			o.f("\n%s has no deployable plan: %s\n", get(c, "id"), Untrusted(plan["reason"]))
		}
		if u, ok := c["unreleased"].(map[string]any); ok {
			o.f("\n%s: %s commit(s) ahead of %s (latest main %s); release blocked by: %s\n",
				get(c, "id"), get(u, "commits_ahead"), get(u, "since_tag"), get(u, "latest_main"), get(u, "release_blocked_by"))
		}
	}
}

func updatePlan(o out, r *reader, m map[string]any) {
	target := r.str(m, "", "target")
	name := get(m, "component")
	if target == "group" {
		name = get(m, "group")
	}
	o.f("Plan for %s %s (discovery %s s old)\n", target, name, get(m, "ageSeconds"))
	if sc, ok := m["scope"].(map[string]any); ok {
		o.f("\nNote %s: %s\n", get(sc, "code"), get(sc, "message"))
		if sc["hint"] != nil {
			o.f("     try: %s\n", get(sc, "hint"))
		}
		d := asMap(sc["details"])
		if d["would_recreate"] != nil {
			o.f("     would also recreate: %s\n", get(d, "would_recreate"))
		}
	}
	p, ok := m["plan"].(map[string]any)
	if !ok {
		if _, present := m["plan"]; !present {
			r.missing = append(r.missing, "plan")
		}
		o.f("\nNo plan.\n")
		if m["reason"] != nil {
			o.f("Reason: %s\n", Untrusted(m["reason"]))
		}
		return
	}
	o.f("\nPlan id    %s\n", r.str(p, "plan.", "id"))
	if p["from"] != nil || p["to"] != nil {
		o.f("Change     %s -> %s\n", versionOf(p["from"]), versionOf(p["to"]))
	}
	for _, k := range []string{"level", "class", "confirm", "confirmWord", "recipe", "oneWay", "oneWayWhy", "changelog"} {
		if p[k] != nil {
			o.f("%-10s %s\n", strings.ToUpper(k[:1])+k[1:], get(p, k))
		}
	}
	if p["downtime"] != nil {
		o.f("Downtime   %s\n", get(p, "downtime"))
	}
	if p["rollback"] != nil {
		o.f("Rollback   %s\n", get(p, "rollback"))
	}
	if mem, ok := p["members"].([]any); ok {
		rows := make([][]string, 0, len(mem))
		for _, e := range mem {
			x := asMap(e)
			rows = append(rows, []string{get(x, "component"), get(x, "class"), versionOf(x["from"]) + " -> " + versionOf(x["to"]), get(x, "level"), get(x, "planId")})
		}
		o.f("\n")
		o.table([]string{"MEMBER", "CLASS", "CHANGE", "LEVEL", "PLAN ID"}, rows)
	}
	for _, sec := range [][2]string{{"preflight", "Preflight"}, {"verify", "Verify"}, {"restarts", "Restarts"}} {
		if l, ok := p[sec[0]].([]any); ok && len(l) > 0 {
			o.f("\n%s\n", sec[1])
			for _, e := range l {
				o.f("  - %s\n", scalar(e))
			}
		}
	}
}

func versionOf(v any) string {
	m, ok := v.(map[string]any)
	if !ok {
		return scalar(v)
	}
	if m["version"] != nil {
		return get(m, "version")
	}
	return get(m, "image")
}

func jobs(o out, r *reader, list []any) {
	rows := make([][]string, 0, len(list))
	for _, e := range list {
		j := asMap(e)
		rows = append(rows, []string{get(j, "id"), get(j, "component"), get(j, "state"),
			versionOf(j["from"]) + " -> " + versionOf(j["to"]), get(j, "requestedAt"), duration(j["durationMs"])})
	}
	o.table([]string{"JOB", "COMPONENT", "STATE", "CHANGE", "REQUESTED", "TOOK"}, rows)
	for _, e := range list {
		j := asMap(e)
		if j["error"] != nil {
			o.f("\n%s %s at %s: %s\n", get(j, "component"), get(j, "state"), get(j, "failedStep"), Untrusted(j["error"]))
		}
	}
}

func duration(v any) string {
	n, ok := v.(json.Number)
	if !ok {
		return "-"
	}
	ms, err := n.Int64()
	if err != nil {
		return n.String()
	}
	if ms < 1000 {
		return fmt.Sprintf("%d ms", ms)
	}
	return fmt.Sprintf("%.1f s", float64(ms)/1000)
}

func job(o out, r *reader, j map[string]any) {
	o.f("Job        %s\n", r.str(j, "job.", "id"))
	o.f("Component  %s\n", r.str(j, "job.", "component"))
	o.f("State      %s\n", r.str(j, "job.", "state"))
	o.f("Change     %s -> %s\n", versionOf(j["from"]), versionOf(j["to"]))
	o.f("Requested  %s by %s\n", get(j, "requestedAt"), get(j, "requestedBy"))
	o.f("Started    %s  ended %s  took %s\n", get(j, "startedAt"), get(j, "endedAt"), duration(j["durationMs"]))
	if j["failedStep"] != nil {
		o.f("Failed at  %s\n", get(j, "failedStep"))
	}
	if j["error"] != nil {
		o.f("Error      %s\n", Untrusted(j["error"]))
	}
	if j["note"] != nil {
		o.f("Note       %s\n", Untrusted(j["note"]))
	}
	steps := r.arr(j, "job.", "steps")
	if len(steps) > 0 {
		rows := make([][]string, 0, len(steps))
		for _, e := range steps {
			s := asMap(e)
			rows = append(rows, []string{get(s, "name"), get(s, "state"), get(s, "startedAt"), Untrusted(s["detail"])})
		}
		o.f("\n")
		o.table([]string{"STEP", "STATE", "STARTED", "DETAIL"}, rows)
	}
}

func events(o out, r *reader, m map[string]any) {
	list := r.arr(m, "", "events")
	rows := make([][]string, 0, len(list))
	for _, e := range list {
		ev := asMap(e)
		rows = append(rows, []string{get(ev, "ts"), get(ev, "type"), get(ev, "component"), get(ev, "state"), get(ev, "id"), Untrusted(ev["text"])})
	}
	o.table([]string{"TIME", "TYPE", "COMPONENT", "STATE", "ID", "TEXT"}, rows)
	o.f("\ncursor %s, more: %s\n", get(m, "cursor"), get(m, "more"))
}

func settings(o out, r *reader, m map[string]any) {
	o.f("Setting    %s.%s\n", r.str(m, "", "module"), r.str(m, "", "key"))
	set := r.need(m, "", "set") == true
	secret := r.need(m, "", "secret") == true
	switch {
	case secret:
		o.f("Value      (secret, not shown)  fingerprint %s\n", get(m, "fingerprint"))
	case !set:
		o.f("Value      (not set)\n")
	default:
		o.f("Value      %s  (%s)\n", Untrusted(r.need(m, "", "value")), r.str(m, "", "value_type"))
	}
	if set {
		o.f("Version    %s, updated %s by %s\n", get(m, "version"), get(m, "updated_at"), get(m, "updated_by"))
	}
}
