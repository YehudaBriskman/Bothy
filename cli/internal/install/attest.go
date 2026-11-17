package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// AttestRepo is the GitHub repository whose release attestations are trusted.
const AttestRepo = "YehudaBriskman/Bothy"

// checkAttestation is decision Q2: the hash line in checksums.txt is the anchor,
// and the release attests checksums.txt. When a working `gh` is present it is
// asked to verify that attestation. Otherwise the check is SKIPPED with a
// one-line reason and the exact command to run by hand. It never reports a check
// it did not make, and it never touches the sha256 checks (those are separate and
// always run). Only a verdict from gh ("this is not attested") is fatal, unless
// requireAttest turns every skip into a failure too (--require-attestation).
//
// Telling "gh cannot verify" from "gh verified and said no" (see classifyGh):
// gh documents exit 0 ok, 1 failure, 2 cancelled, 4 authentication required, and
// uses 1 for both a refused verdict AND for plumbing errors, so the exit code
// alone cannot separate them; the output is read for the known verdict forms.
//
// The check sits behind this one function so a built-in verifier can replace the
// `gh` call later without touching install or update.
func checkAttestation(ctx context.Context, h Host, checksumsSrc string, checksums []byte, out io.Writer, requireAttest bool) error {
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	cmd := fmt.Sprintf("gh attestation verify checksums.txt --repo %s   (run it in a directory holding the release's checksums.txt)", AttestRepo)
	skip := func(reason string) error {
		if requireAttest {
			return fmt.Errorf("attestation: %s, and --require-attestation is set. Verify it yourself with: %s", reason, cmd)
		}
		p("attestation: SKIPPED. %s. The sha256 checks still ran. To check the release's attestation yourself: %s", reason, cmd)
		return nil
	}
	if u, err := url.Parse(checksumsSrc); err != nil || u.Scheme != "https" {
		return skip("checksums.txt came from a local file, not a release download, so there is nothing to attest")
	}
	if _, err := h.Run(ctx, "gh", "--version"); err != nil {
		return skip("`gh` is not installed")
	}
	dir, err := os.MkdirTemp("", "bothy-attest-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	f := filepath.Join(dir, "checksums.txt")
	if err := os.WriteFile(f, checksums, 0o600); err != nil {
		return err
	}
	o, err := h.Run(ctx, "gh", "attestation", "verify", f, "--repo", AttestRepo)
	if err == nil {
		p("attestation: verified by gh (checksums.txt is attested by %s)", AttestRepo)
		return nil
	}
	verdict, why := classifyGh(o, err)
	if verdict {
		return fmt.Errorf("attestation: `gh attestation verify` says checksums.txt is NOT attested by %s (%s): %s", AttestRepo, why, strings.TrimSpace(firstLine(string(o))))
	}
	return skip(fmt.Sprintf("`gh` could not verify it (%s: %s)", why, strings.TrimSpace(firstLine(string(o)))))
}

// classifyGh decides whether a failed `gh attestation verify` is a verdict
// (true: refuse) or gh being unable to verify (false: skip). Measured on gh
// 2.96 and by the lab on 2.45 / 2.104:
//
//	not a verdict (skip): exit 4 (not logged in); "unknown command" / "unknown
//	  flag" (gh older than 2.49, no `attestation`); exit 127 or a start failure;
//	  "HTTP 401/403/5xx", "error creating Sigstore verifier", a dial/timeout/
//	  TLS/DNS error, anything else unrecognised.
//	verdict (refuse): "no attestations found"; "verifying with issuer" (the
//	  signature or the identity/workflow policy did not match); "failed to
//	  verify"; "verification failed"; "HTTP 404" from the attestations API
//	  (for a public repository and a working login, 404 means gh found no
//	  attestation for this checksums.txt digest, which is what a tampered
//	  file looks like).
//
// Unrecognised exit-1 output is treated as NOT a verdict: refusing on a
// message nobody has seen would fail every stock machine again, and the sha256
// checks still anchor the install. --require-attestation closes that gap for
// anyone who prefers it.
func classifyGh(out []byte, err error) (verdict bool, why string) {
	var ee interface{ ExitCode() int }
	code := -1
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	}
	low := strings.ToLower(string(out))
	switch {
	case code == 4 || strings.Contains(low, "gh auth login"):
		return false, "gh is not logged in; run `gh auth login`"
	case strings.Contains(low, "unknown command") || strings.Contains(low, "unknown flag"):
		return false, "this gh is too old and has no `attestation` command; gh 2.49 or newer is needed"
	case code == 127 || code == -1:
		return false, "gh could not be run"
	}
	for _, m := range []string{"no attestations found", "verifying with issuer", "failed to verify", "verification failed", "http 404"} {
		if strings.Contains(low, m) {
			return true, "gh exit " + strconv.Itoa(code)
		}
	}
	return false, "gh exit " + strconv.Itoa(code)
}
