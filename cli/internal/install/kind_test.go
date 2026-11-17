package install

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mk(t *testing.T, p string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeCheckout(t *testing.T, root string) {
	mk(t, filepath.Join(root, ".git"), "gitdir: x\n") // a worktree's .git is a file
	mk(t, filepath.Join(root, "apps", "bothy-ops", "updates.toml"), "")
}

func TestDetectKind(t *testing.T) {
	tmp := t.TempDir()
	data := filepath.Join(tmp, "data", "bothy")
	empty := filepath.Join(tmp, "empty")
	os.MkdirAll(empty, 0o755)

	if r := DetectKind(data, empty); r.Kind != KindNone {
		t.Errorf("nothing present: %+v", r)
	}
	mk(t, filepath.Join(data, "receipt.json"), "{}")
	if r := DetectKind(data, empty); r.Kind != KindInstalled || r.Receipt == "" || r.Checkout != "" {
		t.Errorf("receipt only: %+v", r)
	}
	if r := DetectKind(data, ""); r.Kind != KindInstalled {
		t.Errorf("an empty start must be skipped: %+v", r)
	}

	co := filepath.Join(tmp, "stacks")
	fakeCheckout(t, co)
	deep := filepath.Join(co, "cli", "bin")
	os.MkdirAll(deep, 0o755)
	nodata := filepath.Join(tmp, "nodata", "bothy")
	if r := DetectKind(nodata, deep); r.Kind != KindCheckout || r.Checkout != co {
		t.Errorf("checkout found from a subdirectory: %+v", r)
	}
	if r := DetectKind(nodata, empty, deep); r.Kind != KindCheckout {
		t.Errorf("a later start finds it: %+v", r)
	}
	if r := DetectKind(data, deep); r.Kind != KindAmbiguous {
		t.Errorf("receipt and checkout: %+v", r)
	}
	if KindAmbiguous.UpdatePath() == KindInstalled.UpdatePath() || KindNone.UpdatePath() != "none" {
		t.Error("update path names")
	}

	// A .git without the repo's own updater catalog is somebody else's repo.
	other := filepath.Join(tmp, "other")
	mk(t, filepath.Join(other, ".git"), "x")
	if r := DetectKind(nodata, other); r.Kind != KindNone {
		t.Errorf("foreign repo must not count: %+v", r)
	}
	// A receipt that is a directory is not a receipt.
	os.MkdirAll(filepath.Join(tmp, "d2", "bothy", "receipt.json"), 0o755)
	if r := DetectKind(filepath.Join(tmp, "d2", "bothy"), empty); r.Kind != KindNone {
		t.Errorf("receipt dir: %+v", r)
	}
}

func TestCheckRelease(t *testing.T) {
	r := newRelSrv(t)
	r.publish("2026.11.0", relOpt{})
	r.publish("2026.12.0", relOpt{})
	r.publish("2027.1.0", relOpt{prerelease: true})
	kr := KindReport{Kind: KindInstalled}

	got := CheckRelease(context.Background(), r.source(), "2026.11.2", kr)
	if got.Schema != 1 || !got.UpdateAvailable || got.Latest != "2026.12.0" || got.Tag != "v2026.12.0" || got.Current != "2026.11.2" || got.Error != "" || got.UpdatePath != "bothy update" {
		t.Errorf("newer exists: %+v", got)
	}
	for _, h := range r.hits {
		if !strings.HasPrefix(h, "/repos/") {
			t.Errorf("the check must only touch the API, it fetched %s", h)
		}
	}
	if got := CheckRelease(context.Background(), r.source(), "v2026.12.0", kr); got.UpdateAvailable {
		t.Errorf("same version: %+v", got)
	}
	if got := CheckRelease(context.Background(), r.source(), "2027.3.0", kr); got.UpdateAvailable || got.Error != "" {
		t.Errorf("binary newer than latest: %+v", got)
	}
	if got := CheckRelease(context.Background(), r.source(), "dev", kr); got.UpdateAvailable || got.Current != "" || got.ErrorKind != "other" || got.Latest != "2026.12.0" {
		t.Errorf("non-release build: %+v", got)
	}

	r.apiCode = 429
	if got := CheckRelease(context.Background(), r.source(), "2026.11.2", kr); got.ErrorKind != "rate-limited" || got.UpdateAvailable {
		t.Errorf("rate limit: %+v", got)
	}
	r.apiCode = 0
	r.apiBody = "not json"
	if got := CheckRelease(context.Background(), r.source(), "2026.11.2", kr); got.ErrorKind != "other" || got.Error == "" {
		t.Errorf("bad body: %+v", got)
	}
	src := r.source()
	r.ts.Close()
	if got := CheckRelease(context.Background(), src, "2026.11.2", kr); got.ErrorKind != "offline" {
		t.Errorf("unreachable: %+v", got)
	}
}

func TestReleaseCheckJSONShape(t *testing.T) {
	var buf bytes.Buffer
	if err := (ReleaseCheck{Schema: 1, Kind: KindCheckout, UpdatePath: KindCheckout.UpdatePath(), Current: "2026.11.2"}).WriteJSON(&buf); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"schema", "kind", "updatePath", "current", "updateAvailable"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %q in %s", k, buf.String())
		}
	}
	if _, ok := m["error"]; ok {
		t.Error("error must be omitted when empty")
	}
}
