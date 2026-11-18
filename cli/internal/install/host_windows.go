//go:build windows

package install

import "errors"

// bothy install targets Linux hosts with Docker; the Windows build exists only so the client compiles.
func (SysHost) FreeDiskMiB(dir string) (int, error) {
	return 0, errors.New("bothy install is not supported on Windows")
}

func (SysHost) FSType(dir string) string { return "" }

func (SysHost) Writable(dir string) bool { return false }
