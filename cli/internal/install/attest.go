package install

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// AttestRepo is the GitHub repository whose release attestations are trusted.
const AttestRepo = "YehudaBriskman/Bothy"

// checkAttestation is decision Q2: the hash line in checksums.txt is the anchor,
// and the release attests checksums.txt. When `gh` is present it is asked to
// verify that attestation; when it is not (or the source is a local file, not a
// release download) this prints the exact command and says the check was skipped.
// It never reports a check it did not make. A `gh` that runs and says no is fatal.
//
// The check sits behind this one function so a built-in verifier can replace the
// `gh` call later without touching install or update.
func checkAttestation(ctx context.Context, h Host, checksumsSrc string, checksums []byte, out io.Writer) error {
	p := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	cmd := fmt.Sprintf("gh attestation verify checksums.txt --repo %s   (run it in a directory holding the release's checksums.txt)", AttestRepo)
	if u, err := url.Parse(checksumsSrc); err != nil || u.Scheme != "https" {
		p("attestation: SKIPPED. checksums.txt came from a local file, not a release download, so there is nothing to attest. For a real release run: %s", cmd)
		return nil
	}
	if _, err := h.Run(ctx, "gh", "--version"); err != nil {
		p("attestation: SKIPPED. `gh` is not installed. To check the release's attestation yourself: %s", cmd)
		return nil
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
	if o, err := h.Run(ctx, "gh", "attestation", "verify", f, "--repo", AttestRepo); err != nil {
		return fmt.Errorf("attestation: `gh attestation verify` rejected checksums.txt for %s: %v: %s", AttestRepo, err, strings.TrimSpace(firstLine(string(o))))
	}
	p("attestation: verified by gh (checksums.txt is attested by %s)", AttestRepo)
	return nil
}
