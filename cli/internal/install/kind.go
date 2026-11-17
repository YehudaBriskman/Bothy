package install

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Two install kinds, two update paths (docs/plans/thin-bothy/update-paths.md).
//
//	installed   `bothy install` made this box: a receipt exists, there is no git
//	            checkout. It updates ONLY through `bothy update`.
//	checkout    a repo checkout (~/stacks): the web updater and `git pull` own
//	            it, `main` stays checked out, `bothy update` never touches it.
//
// DetectKind is read-only and cheap: two stats and a walk up the directory
// tree. It never parses the receipt (a damaged receipt is the update verb's
// error to report, not a reason to misclassify the box).
type Kind string

const (
	KindInstalled Kind = "installed"
	KindCheckout  Kind = "checkout"
	// KindAmbiguous: a receipt AND a checkout. Neither updater may act; a person
	// decides which one owns the box.
	KindAmbiguous Kind = "ambiguous"
	// KindNone: neither (a fresh machine, or a bare downloaded binary).
	KindNone Kind = "none"
)

// KindReport says what was found, so the reason can be shown, not just the label.
type KindReport struct {
	Kind     Kind   `json:"kind"`
	Receipt  string `json:"receipt,omitempty"`  // path, when one exists
	Checkout string `json:"checkout,omitempty"` // checkout root, when one was found
}

// UpdatePath names who is allowed to update a box of this kind.
func (k Kind) UpdatePath() string {
	switch k {
	case KindInstalled:
		return "bothy update"
	case KindCheckout:
		return "web updater (git pull, then Settings > Updates)"
	case KindAmbiguous:
		return "none (ambiguous: a receipt and a git checkout both exist)"
	}
	return "none"
}

// isCheckoutRoot: a .git entry (directory, or file for a worktree) next to the
// updater catalog that only this repository has.
func isCheckoutRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return false
	}
	st, err := os.Stat(filepath.Join(dir, "apps", "bothy-ops", "updates.toml"))
	return err == nil && st.Mode().IsRegular()
}

// DetectKind looks for the receipt under dataDir and for a checkout above each
// of the start directories (the running binary's directory, the working
// directory). The first checkout found wins.
func DetectKind(dataDir string, starts ...string) KindReport {
	var r KindReport
	rp := filepath.Join(dataDir, "receipt.json")
	if st, err := os.Stat(rp); err == nil && st.Mode().IsRegular() {
		r.Receipt = rp
	}
	for _, s := range starts {
		if s == "" || r.Checkout != "" {
			continue
		}
		d, err := filepath.Abs(s)
		if err != nil {
			continue
		}
		for i := 0; i < 16; i++ {
			if isCheckoutRoot(d) {
				r.Checkout = d
				break
			}
			up := filepath.Dir(d)
			if up == d {
				break
			}
			d = up
		}
	}
	switch {
	case r.Receipt != "" && r.Checkout != "":
		r.Kind = KindAmbiguous
	case r.Receipt != "":
		r.Kind = KindInstalled
	case r.Checkout != "":
		r.Kind = KindCheckout
	default:
		r.Kind = KindNone
	}
	return r
}

// ReleaseCheck is the machine-readable answer of `bothy update --check --json`:
// "is a newer stable release available?". Schema 1. It is a SIGNAL only: it
// never downloads a release, changes a file, or asks anything to be applied,
// so a future read-only web row can show it without any write path.
type ReleaseCheck struct {
	Schema          int    `json:"schema"`
	Kind            Kind   `json:"kind"`
	UpdatePath      string `json:"updatePath"`
	Current         string `json:"current"`          // this binary's release, "" for a non-release build
	Latest          string `json:"latest,omitempty"` // highest stable release on GitHub
	Tag             string `json:"tag,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Packager        string `json:"packager,omitempty"` // non-empty: a package manager owns the binary
	Error           string `json:"error,omitempty"`
	ErrorKind       string `json:"errorKind,omitempty"` // rate-limited | offline | other
}

// CheckRelease asks GitHub for the latest stable release and compares it with
// binaryVersion. It never returns an error: every failure is encoded in the
// result so the caller can print the document either way.
func CheckRelease(ctx context.Context, src Source, binaryVersion string, kind KindReport) ReleaseCheck {
	res := ReleaseCheck{Schema: 1, Kind: kind.Kind, UpdatePath: kind.Kind.UpdatePath(), Packager: Packager}
	cur, cerr := ParseCalVer(binaryVersion)
	if cerr == nil {
		res.Current = cur.String()
	}
	latest, err := src.Latest(ctx)
	if err != nil {
		res.Error = err.Error()
		var rl *RateLimitError
		var off *OfflineError
		switch {
		case errors.As(err, &rl):
			res.ErrorKind = "rate-limited"
		case errors.As(err, &off):
			res.ErrorKind = "offline"
		default:
			res.ErrorKind = "other"
		}
		return res
	}
	res.Latest, res.Tag = latest.String(), latest.Tag()
	res.UpdateAvailable = cerr == nil && latest.Compare(cur) > 0
	if cerr != nil {
		res.Error = "this binary is not a release build, so it cannot be compared"
		res.ErrorKind = "other"
	}
	return res
}

// WriteJSON prints the check as one indented JSON document.
func (r ReleaseCheck) WriteJSON(w io.Writer) error {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}
