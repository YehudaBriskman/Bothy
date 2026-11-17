// Package cli is the command line: it parses arguments, picks a context, calls
// the API through internal/api and prints through internal/render. The verbs
// and their flags are not written here: they are the rows of catalog.Ops.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/api"
	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
	"github.com/YehudaBriskman/Bothy/cli/internal/config"
	"github.com/YehudaBriskman/Bothy/cli/internal/mcpserver"
	"github.com/YehudaBriskman/Bothy/cli/internal/render"
)

// IO is everything Run touches outside its arguments, so tests can fake it.
type IO struct {
	In      io.Reader
	Out     io.Writer
	Err     io.Writer
	Getenv  func(string) string
	Version string
	Commit  string // the build's git sha; "" for an unstamped build
}

// DefaultIO is the real process environment.
func DefaultIO(version string) IO {
	return IO{In: os.Stdin, Out: os.Stdout, Err: os.Stderr, Getenv: os.Getenv, Version: version}
}

type globals struct {
	json    bool
	context string
	url     string
	timeout time.Duration
}

// noValue marks a trailing flag that had no value after it.
const noValue = "\x00"

type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

func usagef(format string, a ...any) error { return usageError{fmt.Sprintf(format, a...)} }

// Run executes the command line and returns the process exit code.
func Run(args []string, io IO) int {
	err := run(args, io)
	if err == nil {
		return api.ExitOK
	}
	var ue usageError
	if errors.As(err, &ue) {
		fmt.Fprintf(io.Err, "bothy: %s\nrun `bothy help` for usage\n", ue.msg)
		return api.ExitUsage
	}
	fmt.Fprintf(io.Err, "bothy: %s\n", err)
	var ae *api.Error
	if errors.As(err, &ae) && ae.RequestID != "" {
		fmt.Fprintf(io.Err, "request id: %s\n", api.OneLine(ae.RequestID))
	}
	return api.ExitCodeOf(err)
}

func run(args []string, io IO) error {
	g := globals{timeout: 15 * time.Second}
	words, flags, err := splitArgs(args)
	if err != nil {
		return err
	}
	if len(words) == 0 {
		return help(io.Out)
	}
	switch words[0] {
	case "help", "--help", "-h":
		return help(io.Out)
	}
	// Global flags are accepted anywhere; op flags are resolved once the verb is known.
	rest := map[string]string{}
	for k, v := range flags {
		if v == noValue && (k == "context" || k == "url" || k == "timeout") {
			return usagef("flag --%s needs a value", k)
		}
		switch k {
		case "json":
			g.json = v != "false"
		case "context":
			g.context = v
		case "url":
			g.url = v
		case "timeout":
			d, derr := time.ParseDuration(v)
			if derr != nil || d <= 0 {
				return usagef("--timeout %q is not a duration like 10s", v)
			}
			g.timeout = d
		case "help", "h":
			if words[0] == "install" || words[0] == "uninstall" {
				fmt.Fprint(io.Out, installHelp)
				return nil
			}
			return help(io.Out)
		default:
			rest[k] = v
		}
	}
	switch words[0] {
	case "context":
		return cmdContext(words[1:], rest, g, io)
	case "mcp":
		return cmdMCP(words[1:], rest, g, io)
	case "version":
		return cmdVersion(rest, g, io)
	case "install":
		return cmdInstall(words[1:], rest, g, io)
	case "uninstall":
		return cmdUninstall(words[1:], rest, g, io)
	case "discover":
		return cmdOp(mustOp("discover"), nil, rest, g, io)
	case "modules": // alias of `module list`
		words = []string{"module", "list"}
	}
	op, tail, ok := matchOp(words)
	if !ok {
		return unknownVerb(words)
	}
	return cmdOp(op, tail, rest, g, io)
}

// splitArgs separates words from --flags. A flag is `--name=value`,
// `--name value` or a bare `--name` (value "true"); which flags take a value
// is decided later, so a bare flag followed by a word is ambiguous here and
// is resolved in favour of the value for the flags every op declares.
func splitArgs(args []string) (words []string, flags map[string]string, err error) {
	flags = map[string]string{}
	boolFlags := map[string]bool{"json": true, "help": true, "h": true, "use": true, "write": true,
		"dry-run": true, "purge": true, "allow-downgrade": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			words = append(words, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			words = append(words, a)
			continue
		}
		name := strings.TrimLeft(a, "-")
		if name == "" {
			return nil, nil, usagef("bad flag %q", a)
		}
		if k, v, has := strings.Cut(name, "="); has {
			flags[k] = v
			continue
		}
		if boolFlags[name] {
			flags[name] = "true"
			continue
		}
		if i+1 >= len(args) {
			// Whether this is a flag that takes a value, or no flag of the command at all,
			// is decided once the verb is known (an unknown one must say "unknown flag").
			flags[name] = noValue
			continue
		}
		i++
		flags[name] = args[i]
	}
	return words, flags, nil
}

func mustOp(id string) catalog.Op {
	op, ok := catalog.ByID(id)
	if !ok {
		panic("catalog has no op " + id)
	}
	return op
}

// matchOp finds the op whose verb words prefix `words`.
func matchOp(words []string) (catalog.Op, []string, bool) {
	var best catalog.Op
	found := false
	for _, op := range catalog.Ops {
		n := len(op.Verb)
		if n > len(words) || n <= len(best.Verb) && found {
			continue
		}
		match := true
		for i, w := range op.Verb {
			if words[i] != w {
				match = false
				break
			}
		}
		if match {
			best, found = op, true
		}
	}
	if !found {
		return best, nil, false
	}
	return best, words[len(best.Verb):], true
}

func unknownVerb(words []string) error {
	first := words[0]
	var sub []string
	for _, op := range catalog.Ops {
		if len(op.Verb) > 1 && op.Verb[0] == first {
			sub = append(sub, op.VerbString())
		}
	}
	if len(sub) > 0 {
		return usagef("%q needs one of: %s", first, strings.Join(sub, ", "))
	}
	return usagef("unknown command %q", strings.Join(words, " "))
}

func help(w io.Writer) error {
	fmt.Fprintln(w, "bothy - a thin client for a Bothy box (read-only in this version)")
	fmt.Fprintln(w, "\nUsage: bothy [--json] [--context NAME] [--url URL] [--timeout 15s] <command> [args]")
	fmt.Fprintln(w, "\nCommands from the catalog:")
	for _, op := range catalog.Ops {
		line := "  " + op.VerbString()
		for _, p := range op.Params {
			switch {
			case p.Required:
				line += " <" + p.Name + ">"
			default:
				line += " [--" + p.Name + " " + strings.ToUpper(p.Name) + "]"
			}
		}
		fmt.Fprintf(w, "%-48s %s\n", line, shortTitle(op))
	}
	fmt.Fprintln(w, "\nOther commands:")
	fmt.Fprintln(w, "  discover                                       The operations this box offers")
	fmt.Fprintln(w, "  modules                                        Alias of `module list`")
	fmt.Fprintln(w, "  context add NAME URL [--token-file F] [--use]  Remember a box")
	fmt.Fprintln(w, "  context list | use NAME                        List boxes, or choose the current one")
	fmt.Fprintln(w, "  install [--dry-run] [--mode mini] ...          Install Bothy on this machine (Docker Compose; see install --help)")
	fmt.Fprintln(w, "  uninstall [--purge] [--dry-run]                Remove it; data is kept unless --purge and you type the phrase")
	fmt.Fprintln(w, "  mcp                                            Serve the read-only tools over stdio (MCP)")
	fmt.Fprintln(w, "\nExit codes: 0 ok, 10 box unreachable, 64 bad usage or request, 66 not found,")
	fmt.Fprintln(w, "69 data source unavailable, 70 server bug, 77 not signed in or not allowed, 78 version mismatch.")
	return nil
}

func shortTitle(op catalog.Op) string {
	if op.Description != "" {
		return op.Description
	}
	return ""
}

func (g globals) client(io IO) (*api.Client, error) {
	var ctx config.Context
	switch {
	case g.url != "":
		ctx = config.Context{URL: g.url}
	case io.Getenv("BOTHY_URL") != "":
		ctx = config.Context{URL: io.Getenv("BOTHY_URL")}
	default:
		f, err := config.Load()
		if err != nil {
			return nil, err
		}
		name := g.context
		if name == "" {
			name = io.Getenv("BOTHY_CONTEXT")
		}
		if name == "" {
			name = f.Current
		}
		if name == "" {
			return nil, usagef("no box configured: run `bothy context add NAME URL`, or pass --url")
		}
		c, ok := f.Contexts[name]
		if !ok {
			return nil, usagef("no context %q (have: %s)", name, strings.Join(f.Names(), ", "))
		}
		ctx = c
	}
	tok, err := config.ReadToken(ctx, io.Getenv)
	if err != nil {
		return nil, err
	}
	return api.New(ctx.URL, tok, io.Version, g.timeout)
}

func cmdOp(op catalog.Op, tail []string, flags map[string]string, g globals, io IO) error {
	args := map[string]string{}
	known := map[string]bool{}
	for _, p := range op.Params {
		known[p.Name] = true
		if v, ok := flags[p.Name]; ok {
			args[p.Name] = v
		}
	}
	for k := range flags {
		if !known[k] {
			return usagef("%s: unknown flag --%s", op.VerbString(), k)
		}
	}
	for k, v := range flags {
		if v == noValue {
			return usagef("%s: flag --%s needs a value", op.VerbString(), k)
		}
	}
	// Positionals fill the required params, in catalog order.
	for _, p := range op.Params {
		if !p.Required {
			continue
		}
		if _, given := args[p.Name]; given || len(tail) == 0 {
			continue
		}
		args[p.Name], tail = tail[0], tail[1:]
	}
	if len(tail) > 0 {
		return usagef("%s: unexpected argument %q", op.VerbString(), tail[0])
	}
	if _, err := api.ValidateArgs(op, args); err != nil {
		return usageError{err.Error()}
	}
	cl, err := g.client(io)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	res, err := cl.Call(ctx, op, args)
	if err != nil {
		return err
	}
	return output(res, op.ID, g, io)
}

func output(res *api.Result, opID string, g globals, io IO) error {
	for _, n := range res.Notices {
		fmt.Fprintf(io.Err, "bothy: note: %s\n", api.OneLine(n))
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(io.Err, "bothy: warning: %s\n", render.Untrusted(w))
	}
	// Render to memory first: a response that fails validation must not leave half a
	// rendering on stdout beside the error.
	var buf bytes.Buffer
	var err error
	if g.json {
		err = render.JSON(&buf, res.Data)
	} else {
		err = render.Human(&buf, opID, res.Data)
	}
	if err != nil {
		return err
	}
	_, err = io.Out.Write(buf.Bytes())
	return err
}

func cmdVersion(flags map[string]string, g globals, io IO) error {
	for k := range flags {
		return usagef("version: unknown flag --%s", k)
	}
	cl, cerr := g.client(io)
	var res *api.Result
	var derr error
	if cerr == nil {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		_, res, derr = cl.Discover(ctx)
	}
	if g.json {
		doc := map[string]any{"client": map[string]any{"version": io.Version, "apiVersion": catalog.APIVersion}}
		if io.Commit != "" {
			doc["client"].(map[string]any)["commit"] = io.Commit
		}
		switch {
		case res != nil:
			var d any
			_ = json.Unmarshal(res.Data, &d)
			doc["server"] = render.SanitizeTree(d)
		case cerr != nil:
			doc["server_error"] = api.OneLine(cerr.Error())
		case derr != nil:
			doc["server_error"] = api.OneLine(derr.Error())
		}
		b, _ := json.MarshalIndent(doc, "", "  ")
		fmt.Fprintf(io.Out, "%s\n", b)
		return nil
	}
	if io.Commit != "" {
		short := io.Commit
		if len(short) > 12 {
			short = short[:12]
		}
		fmt.Fprintf(io.Out, "bothy %s (commit %s, speaks api %d)\n", io.Version, short, catalog.APIVersion)
	} else {
		fmt.Fprintf(io.Out, "bothy %s (speaks api %d)\n", io.Version, catalog.APIVersion)
	}
	switch {
	case res != nil:
		fmt.Fprintf(io.Out, "box    %s api=%d min-client=%s\n", api.OneLine(res.Server.Version), res.Server.API, api.OneLine(res.Server.MinClient))
		for _, n := range res.Notices {
			fmt.Fprintf(io.Err, "bothy: note: %s\n", api.OneLine(n))
		}
	case cerr != nil:
		fmt.Fprintf(io.Out, "box    not configured (%s)\n", api.OneLine(cerr.Error()))
	default:
		fmt.Fprintf(io.Out, "box    unavailable: %s\n", api.OneLine(derr.Error()))
		var se *api.SkewError
		if errors.As(derr, &se) {
			return derr
		}
	}
	return nil
}

func cmdContext(words []string, flags map[string]string, g globals, io IO) error {
	if len(words) == 0 {
		return usagef("context needs one of: add, list, use")
	}
	f, err := config.Load()
	if err != nil {
		return err
	}
	switch words[0] {
	case "list":
		if len(words) != 1 || len(flags) > 0 {
			return usagef("context list takes no arguments")
		}
		if g.json {
			b, _ := json.MarshalIndent(f, "", "  ")
			fmt.Fprintf(io.Out, "%s\n", b)
			return nil
		}
		if len(f.Contexts) == 0 {
			fmt.Fprintln(io.Out, "no contexts: run `bothy context add NAME URL`")
			return nil
		}
		for _, n := range f.Names() {
			mark := " "
			if n == f.Current {
				mark = "*"
			}
			c := f.Contexts[n]
			tok := ""
			if c.TokenFile != "" {
				tok = "  token-file " + api.OneLine(c.TokenFile)
			}
			fmt.Fprintf(io.Out, "%s %-16s %s%s\n", mark, n, api.OneLine(c.URL), tok)
		}
		return nil
	case "use":
		if len(words) != 2 || len(flags) > 0 {
			return usagef("usage: bothy context use NAME")
		}
		if err := f.Use(words[1]); err != nil {
			return usageError{err.Error()}
		}
		if err := f.Save(); err != nil {
			return err
		}
		fmt.Fprintf(io.Out, "using %s\n", words[1])
		return nil
	case "add":
		if len(words) != 3 {
			return usagef("usage: bothy context add NAME URL [--token-file FILE] [--use]")
		}
		for k, v := range flags {
			if k != "token-file" && k != "use" {
				return usagef("context add: unknown flag --%s", k)
			}
			if v == noValue {
				return usagef("context add: flag --%s needs a value", k)
			}
		}
		c := config.Context{URL: words[2], TokenFile: flags["token-file"]}
		if c.TokenFile != "" {
			// Refuse now, not at first use, a token that could never be sent.
			if _, err := api.New(c.URL, "placeholder", io.Version, 0); err != nil {
				return usageError{err.Error()}
			}
		}
		if err := f.Add(words[1], c); err != nil {
			return usageError{err.Error()}
		}
		if flags["use"] == "true" {
			f.Current = words[1]
		}
		if err := f.Save(); err != nil {
			return err
		}
		fmt.Fprintf(io.Out, "added %s\n", words[1])
		return nil
	}
	return usagef("context: unknown subcommand %q (add, list, use)", words[0])
}

func cmdMCP(words []string, flags map[string]string, g globals, io IO) error {
	if len(words) > 0 {
		return usagef("mcp takes no arguments")
	}
	for k := range flags {
		if k == "write" || k == "allow" {
			return usagef("mcp --%s: write tools do not exist in this version; `bothy mcp` serves read tools only", k)
		}
		return usagef("mcp: unknown flag --%s", k)
	}
	cl, err := g.client(io)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return mcpserver.Run(ctx, cl, io.Version, nil, nil)
}
