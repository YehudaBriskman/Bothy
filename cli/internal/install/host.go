package install

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// SysHost is the real machine.
type SysHost struct{}

func (SysHost) GOOS() string           { return runtime.GOOS }
func (SysHost) GOARCH() string         { return runtime.GOARCH }
func (SysHost) Euid() int              { return os.Geteuid() }
func (SysHost) Getenv(k string) string { return os.Getenv(k) }

// Run only ever runs docker: the allow-list is here, not at the call sites.
func (SysHost) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if name != "docker" {
		return nil, fmt.Errorf("install: refusing to run %q (only docker is ever run)", name)
	}
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (SysHost) MemAvailableMiB() (int, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "MemAvailable:") {
			fs := strings.Fields(sc.Text())
			kb, err := strconv.Atoi(fs[1])
			return kb / 1024, err
		}
	}
	return 0, fmt.Errorf("no MemAvailable in /proc/meminfo")
}

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

// ListenAddrs reads the kernel's TCP tables: a listener on `port`, any address.
func (SysHost) ListenAddrs(port int) []string {
	var out []string
	for _, f := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		fh, err := os.Open(f)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(fh)
		sc.Scan() // header
		for sc.Scan() {
			c := strings.Fields(sc.Text())
			if len(c) < 4 || c[3] != "0A" { // 0A = LISTEN
				continue
			}
			addr, p, ok := strings.Cut(c[1], ":")
			if !ok {
				continue
			}
			if n, _ := strconv.ParseInt(p, 16, 32); int(n) != port {
				continue
			}
			out = append(out, hexAddr(addr))
		}
		fh.Close()
	}
	return out
}

// hexAddr decodes /proc/net/tcp addresses: IPv4 is one little-endian word;
// IPv6 is four of them. An all-zero address is the wildcard.
func hexAddr(h string) string {
	switch len(h) {
	case 8:
		n, _ := strconv.ParseUint(h, 16, 32)
		return fmt.Sprintf("%d.%d.%d.%d", n&0xff, n>>8&0xff, n>>16&0xff, n>>24&0xff)
	case 32:
		if strings.Trim(h, "0") == "" {
			return "::"
		}
		if strings.HasPrefix(h, "0000000000000000FFFF0000") { // v4-mapped
			return hexAddr(h[24:])
		}
		if h == "00000000000000000000000001000000" {
			return "::1"
		}
		return "ipv6:" + h
	}
	return h
}
