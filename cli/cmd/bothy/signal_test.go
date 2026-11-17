//go:build !windows

package main

import (
	"bytes"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/testkit"
)

// Ctrl-C while a call is parked on the box ends the process promptly, with a
// clean message and a non-zero code, not a goroutine dump and not a hang.
func TestSIGINTDuringACall(t *testing.T) {
	bin := buildBinary(t)
	block := make(chan struct{})
	srv := newBlockingServer(testkit.Named(t, "discover").Body, block)
	defer srv.Close()
	defer close(block)
	cmd := exec.Command(bin, "--url", srv.URL, "--timeout", "60s", "status")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "XDG_CONFIG_HOME=" + t.TempDir()}
	var o, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &e
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(700 * time.Millisecond)
	_ = cmd.Process.Signal(syscall.SIGINT)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("SIGINT did not stop the CLI within 5 s")
	}
	if code := cmd.ProcessState.ExitCode(); code == 0 {
		t.Errorf("exit 0 after SIGINT")
	}
	if strings.Contains(e.String(), "goroutine") || strings.Contains(e.String(), "panic") {
		t.Errorf("crash on SIGINT: %s", e.String())
	}
	if o.Len() != 0 {
		t.Errorf("stdout not empty: %q", o.String())
	}
}

// The reader of a pipe goes away (`bothy ... | head -1`): no panic text, whatever the exit status.
func TestClosedStdoutPipe(t *testing.T) {
	bin := buildBinary(t)
	s := testkit.NewServer(t)
	cmd := exec.Command(bin, "--url", s.URL, "update", "status")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "XDG_CONFIG_HOME=" + t.TempDir()}
	out, _ := cmd.StdoutPipe()
	var e bytes.Buffer
	cmd.Stderr = &e
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	_ = out.Close() // the reader is gone before the first byte
	_ = cmd.Wait()
	if strings.Contains(e.String(), "goroutine") || strings.Contains(e.String(), "panic") {
		t.Errorf("crash on a closed pipe: %s", e.String())
	}
}
