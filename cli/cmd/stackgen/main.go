// Command stackgen writes the embedded install stack (see internal/stackgen).
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/YehudaBriskman/Bothy/cli/internal/stackgen"
)

func main() {
	repo := flag.String("repo", "", "repository root (holds stack/modes.yml)")
	out := flag.String("out", "", "directory the `stack/` tree is written into")
	flag.Parse()
	if *repo == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: stackgen -repo DIR -out DIR")
		os.Exit(64)
	}
	files, err := stackgen.Generate(*repo)
	if err != nil {
		fmt.Fprintln(os.Stderr, "stackgen:", err)
		os.Exit(1)
	}
	// Start from nothing so a removed service leaves no stale file behind.
	if err := os.RemoveAll(filepath.Join(*out, "stack")); err != nil {
		fmt.Fprintln(os.Stderr, "stackgen:", err)
		os.Exit(1)
	}
	for p, b := range files {
		dst := filepath.Join(*out, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "stackgen:", err)
			os.Exit(1)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			fmt.Fprintln(os.Stderr, "stackgen:", err)
			os.Exit(1)
		}
	}
}
