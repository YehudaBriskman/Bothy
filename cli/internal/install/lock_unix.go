//go:build !windows

package install

import (
	"fmt"
	"os"
	"syscall"
)

// flockFile takes a non-blocking exclusive flock on path (created 0600). The
// kernel drops it if the process dies, so a crash never leaves a stale lock.
func flockFile(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("another `bothy install` or `bothy update` is already running for this install root (lock %s); wait for it to finish", path)
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
