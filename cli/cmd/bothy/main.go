package main

import (
	"os"

	"github.com/YehudaBriskman/Bothy/cli/internal/cli"
)

// version and commit are stamped at build time by scripts/build-cli.sh:
// -ldflags "-X main.version=2026.11.0 -X main.commit=<sha>".
var (
	version = "dev"
	commit  = ""
)

func main() {
	io := cli.DefaultIO(version)
	io.Commit = commit
	os.Exit(cli.Run(os.Args[1:], io))
}
