//go:build windows

package install

// The Windows build exists only so the client compiles; install is Linux-only.
func flockFile(path string) (func(), error) { return func() {}, nil }
