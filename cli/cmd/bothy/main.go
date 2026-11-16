package main

import (
	"os"

	"github.com/YehudaBriskman/Bothy/cli/internal/cli"
)

// version is stamped at build time: -ldflags "-X main.version=2026.11.0".
var version = "dev"

func main() { os.Exit(cli.Run(os.Args[1:], cli.DefaultIO(version))) }
