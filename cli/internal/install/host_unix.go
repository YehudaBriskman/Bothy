//go:build !windows

package install

import "syscall"

func (SysHost) FreeDiskMiB(dir string) (int, error) {
	var s syscall.Statfs_t
	if err := syscall.Statfs(dir, &s); err != nil {
		return 0, err
	}
	return int(uint64(s.Bavail) * uint64(s.Bsize) >> 20), nil
}

func (SysHost) FSType(dir string) string {
	var s syscall.Statfs_t
	if err := syscall.Statfs(dir, &s); err != nil {
		return ""
	}
	switch uint32(s.Type) {
	case 0x01021997:
		return "9p"
	case 0x6969:
		return "nfs"
	case 0xff534d42, 0x517b:
		return "cifs"
	case 0x65735546:
		return "fuse"
	}
	return ""
}
