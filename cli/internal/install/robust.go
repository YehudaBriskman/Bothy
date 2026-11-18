package install

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// netHint turns the text of a failed download or `docker pull` into the one
// thing a person can do about it. It only classifies; it never retries and
// never changes anything. Order matters: the specific causes come first.
func netHint(text string) string {
	t := strings.ToLower(text)
	has := func(ss ...string) bool {
		for _, s := range ss {
			if strings.Contains(t, s) {
				return true
			}
		}
		return false
	}
	switch {
	case has("no space left on device"):
		return "The disk is full. Free space where Docker stores images (`docker system df`, `docker image prune`) and run `bothy install` again: layers already pulled are kept."
	case has("x509: certificate has expired", "not yet valid", "certificate is not yet valid"):
		return "A certificate is rejected as expired or not yet valid. The usual cause is this machine's clock being wrong: check `date` and `timedatectl`, fix the time, run again."
	case has("x509:", "certificate signed by unknown authority", "tls: failed to verify"):
		return "TLS verification failed. Behind a corporate proxy that re-signs HTTPS, install its root certificate for Docker (and this machine) first."
	case has("toomanyrequests", "rate limit", "too many requests"):
		return "The registry is rate-limiting this address. Wait a few minutes and run `bothy install` again (finished steps are skipped), or sign in with `docker login ghcr.io`."
	case has("unauthorized", "denied: ", "requested access to the resource is denied"):
		return "The registry refused anonymous access. Check the release is published, or sign in with `docker login ghcr.io`."
	case has("no such host", "temporary failure in name resolution", "server misbehaving", "lookup "):
		return "A name did not resolve: this machine looks offline or its DNS is blocked. Check the network, then run `bothy install` again; nothing is lost (the install resumes)."
	case has("proxyconnect", "proxy"):
		return "A proxy is in the way. bothy reads HTTPS_PROXY for its own downloads, but the Docker DAEMON has its own proxy setting (systemd drop-in or ~/.docker/config.json); set it there and run again."
	case has("i/o timeout", "context deadline exceeded", "connection refused", "network is unreachable", "no route to host", "connection reset", "tls handshake timeout", "unexpected eof", "client.timeout"):
		return "The network dropped or blocked the connection (offline, a firewall, a proxy, or the registry being down). Run `bothy install` again when it is back: finished steps are skipped and pulled layers are kept. A proxy for the Docker daemon is configured in Docker, not here."
	}
	return ""
}

// withHint appends the hint, if any, to an error message.
func withHint(msg string) string {
	if h := netHint(msg); h != "" {
		return msg + "\n   hint: " + h
	}
	return msg
}

// lockInstall takes an exclusive, non-blocking lock so two `bothy install` or
// `bothy update` runs cannot interleave their writes. It creates the root
// directory if it must (so the lock has somewhere to live) and the returned
// release removes the lock file and, when this call created the directory and
// nothing else is in it, the directory too: a run that stops at preflight
// leaves nothing behind.
func lockInstall(root string) (release func(), err error) {
	// Every directory this call has to create, deepest first, so an empty chain
	// can be removed again.
	var made []string
	for d := root; ; d = filepath.Dir(d) {
		if _, serr := os.Stat(d); serr == nil || d == filepath.Dir(d) {
			break
		}
		made = append(made, d)
	}
	cleanup := func() {
		for _, d := range made {
			if os.Remove(d) != nil { // non-empty: someone else's, keep it
				break
			}
		}
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		cleanup()
		return nil, fmt.Errorf("cannot create %s: %w", root, err)
	}
	path := filepath.Join(root, ".install.lock")
	unlock, err := flockFile(path)
	if err != nil {
		cleanup()
		return nil, err
	}
	return func() {
		unlock()
		_ = os.Remove(path)
		cleanup()
	}, nil
}

// ownRunning reports whether this install's own compose project has running
// containers, so a resumed install is not told its own port is "in use".
func ownRunning(ctx context.Context, h Host, o Options, st *Stack) bool {
	out, err := h.Run(ctx, "docker", o.composeArgs(st, "ps", "-q")...)
	return err == nil && strings.TrimSpace(string(out)) != ""
}
