package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
	"github.com/YehudaBriskman/Bothy/cli/internal/tokens"
)

// `bothy token create|list|revoke` is HOST-ONLY (decision D43): it writes the token file on this
// machine and talks to no box. It is deliberately not a catalog op, so it has no HTTP route, no
// MCP tool and no place in `discover`; internal/cli/token_cmd_test.go and the mcpserver tests pin that.

const tokenHelp = `bothy token - mint and revoke bearer tokens on THIS machine (never over the network)

  bothy token create --ops OP[,OP...]|'*' --name NAME [--kind cli|mcp] [--role viewer|operator]
                     [--ttl 30d] [--out FILE] [--state DIR]
  bothy token list [--state DIR]        (add --json for machine output)
  bothy token revoke ID [--state DIR]

create prints the token ONCE on stdout and nothing else there (or writes it to --out, mode 0600,
and prints nothing); only its SHA-256 digest is stored. Lose it and mint another. The token goes to
the CLI as BOTHY_TOKEN or a 0600 file named by 'context add --token-file'; never as a flag.
State: --state, else $BOTHY_TOKEN_STATE, else ${STATE_ROOT:-~/.local/state}/bothy/tokens (0700).
Defaults: kind cli, role viewer, ttl 30d (1m to 365d).
`

var ttlRE = regexp.MustCompile(`^([0-9]{1,9})([smhd]?)$`)

func parseTTL(s string) (time.Duration, error) {
	m := ttlRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, fmt.Errorf("--ttl %q is not like 90m, 12h, 30d or a number of seconds", s)
	}
	n, _ := strconv.ParseInt(m[1], 10, 64)
	unit := map[string]time.Duration{"": time.Second, "s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour}[m[2]]
	d := time.Duration(n) * unit
	if d < tokens.MinTTL || d > tokens.MaxTTL {
		return 0, fmt.Errorf("--ttl must be between 1 minute and 365 days")
	}
	return d, nil
}

func tokenState(flag string, io IO) string {
	if flag != "" {
		return flag
	}
	if d := io.Getenv("BOTHY_TOKEN_STATE"); d != "" {
		return d
	}
	root := io.Getenv("STATE_ROOT")
	if root == "" {
		h, err := os.UserHomeDir()
		if err != nil {
			h = "."
		}
		root = filepath.Join(h, ".local", "state")
	}
	return filepath.Join(root, "bothy", "tokens")
}

// refuseIfNetwork mirrors tokenctl.py: a CGI/HTTP environment, or a socket as stdin (inetd,
// a socket activator, `nc -e`), is not a local operator.
func refuseIfNetwork(io IO) error {
	for _, k := range []string{"GATEWAY_INTERFACE", "REQUEST_METHOD"} {
		if io.Getenv(k) != "" {
			return errors.New("token: this is a local command: it will not run from a web request")
		}
	}
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "HTTP_") {
			return errors.New("token: this is a local command: it will not run from a web request")
		}
	}
	if f, ok := io.In.(*os.File); ok {
		if st, err := f.Stat(); err == nil && st.Mode()&os.ModeSocket != 0 {
			return errors.New("token: this is a local command: it will not run with a network socket as its input")
		}
	}
	return nil
}

func cmdToken(words []string, flags map[string]string, g globals, io IO) error {
	if len(words) == 0 {
		return usagef("token needs one of: create, list, revoke")
	}
	if err := refuseIfNetwork(io); err != nil {
		return err
	}
	allowed := map[string]map[string]bool{
		"create": {"kind": true, "role": true, "ops": true, "name": true, "ttl": true, "out": true, "state": true},
		"list":   {"state": true},
		"revoke": {"state": true},
	}
	sub := words[0]
	ok, known := allowed[sub]
	if !known {
		return usagef("token: unknown subcommand %q (create, list, revoke)", sub)
	}
	for k, v := range flags {
		if !ok[k] {
			return usagef("token %s: unknown flag --%s", sub, k) // the name only: a value may be a secret
		}
		if v == noValue {
			return usagef("token %s: flag --%s needs a value", sub, k)
		}
	}
	env := tokens.Env{KnownOp: func(id string) bool { _, found := catalog.ByID(id); return found }}
	state := tokenState(flags["state"], io)
	switch sub {
	case "create":
		if len(words) != 1 {
			return usagef("token create takes flags only")
		}
		for _, req := range []string{"ops", "name"} {
			if flags[req] == "" {
				return usagef("token create: --%s is required", req)
			}
		}
		spec := tokens.Spec{Kind: "cli", Role: "viewer", Name: flags["name"], TTL: tokens.DefaultTTL}
		if v := flags["kind"]; v != "" {
			spec.Kind = v
		}
		if v := flags["role"]; v != "" {
			spec.Role = v
		}
		for _, o := range strings.Split(flags["ops"], ",") {
			if o != "" {
				spec.Ops = append(spec.Ops, o)
			}
		}
		if v := flags["ttl"]; v != "" {
			d, err := parseTTL(v)
			if err != nil {
				return usageError{err.Error()}
			}
			spec.TTL = d
		}
		var out *os.File
		if p := flags["out"]; p != "" {
			// Create the destination BEFORE minting: a refusal here must not strand a live token.
			f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return fmt.Errorf("--out: %w", errPathless(err))
			}
			out = f
		}
		tok, pub, err := tokens.Create(state, spec, env)
		if err != nil {
			if out != nil {
				out.Close()
				os.Remove(out.Name())
			}
			return err
		}
		if out != nil {
			_, werr := out.WriteString(tok + "\n")
			if cerr := out.Close(); werr == nil {
				werr = cerr
			}
			if werr != nil {
				return fmt.Errorf("token %s was minted but could not be written to --out (%v): revoke it with `bothy token revoke %s`", pub.ID, werr, pub.ID)
			}
		} else {
			fmt.Fprintln(io.Out, tok)
		}
		fmt.Fprintf(io.Err, "created token %s (%s, %s, expires %s). The secret was shown once and is not stored; lose it and mint another.\n",
			pub.ID, pub.Kind, pub.Role, time.Unix(pub.Expires, 0).UTC().Format("2006-01-02"))
		return nil
	case "list":
		if len(words) != 1 {
			return usagef("token list takes no arguments")
		}
		list, err := tokens.List(state, env)
		if err != nil {
			return err
		}
		if g.json {
			rows := make([]map[string]any, 0, len(list))
			for _, p := range list {
				rows = append(rows, map[string]any{"id": p.ID, "status": p.Status, "kind": p.Kind, "role": p.Role, "ops": p.Ops,
					"name": p.Name, "created": p.Created, "expires": p.Expires, "revoked_at": p.RevokedAt, "last_used": p.LastUsed})
			}
			b, _ := json.MarshalIndent(rows, "", "  ")
			fmt.Fprintf(io.Out, "%s\n", b)
			return nil
		}
		iso := func(t *int64) string {
			if t == nil {
				return "-"
			}
			return time.Unix(*t, 0).UTC().Format("2006-01-02T15:04Z")
		}
		for _, p := range list {
			exp := p.Expires
			fmt.Fprintf(io.Out, "%s  %-7s  %-3s  %-8s  expires %s  used %s  ops %s  %s\n", p.ID, p.Status, p.Kind, p.Role,
				iso(&exp), iso(p.LastUsed), strings.Join(p.Ops, ","), p.Name)
		}
		return nil
	default: // revoke
		if len(words) != 2 {
			return usagef("usage: bothy token revoke ID")
		}
		did, err := tokens.Revoke(state, words[1], env)
		if err != nil {
			return err
		}
		if did {
			fmt.Fprintf(io.Err, "revoked %s\n", words[1])
		} else {
			fmt.Fprintf(io.Err, "already revoked %s\n", words[1])
		}
		return nil
	}
}

func errPathless(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
