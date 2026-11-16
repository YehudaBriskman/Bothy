// Command catalogen regenerates internal/catalog/ops_gen.go from the catalog JSON.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/YehudaBriskman/Bothy/cli/internal/catalogen"
)

func main() {
	verbs := flag.String("verbs", "", "cli-verbs.v1.json")
	tools := flag.String("tools", "", "mcp-tools.v1.json")
	out := flag.String("out", "", "output Go file")
	flag.Parse()
	vb, err1 := os.ReadFile(*verbs)
	tb, err2 := os.ReadFile(*tools)
	if err1 != nil || err2 != nil {
		fmt.Fprintln(os.Stderr, "catalogen:", err1, err2)
		os.Exit(1)
	}
	src, err := catalogen.Render(vb, tb)
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalogen:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, src, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "catalogen:", err)
		os.Exit(1)
	}
}
