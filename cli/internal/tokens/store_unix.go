//go:build !windows

package tokens

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"syscall"
	"time"
)

func checkDir(state string) error {
	st, err := os.Lstat(state)
	if err != nil {
		return fmt.Errorf("state directory unreadable: %w", pathless(err))
	}
	if st.Mode()&os.ModeSymlink != 0 || !st.IsDir() {
		return errors.New("the state path is a symlink or not a directory")
	}
	if st.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("state directory mode is %04o; it must be 0700", st.Mode().Perm())
	}
	return ownerOK(st)
}

func ownerOK(st os.FileInfo) error {
	if s, ok := st.Sys().(*syscall.Stat_t); ok && int(s.Uid) != os.Geteuid() && s.Uid != 0 {
		return errors.New("the store is owned by someone else")
	}
	return nil
}

func pathless(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

// readFile returns the records. A missing file is an empty store.
func readFile(state string) ([]Record, error) {
	if err := checkDir(state); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(state, FileName), os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("the token file cannot be opened safely: %w", pathless(err))
	}
	defer f.Close()
	st, err := f.Stat() // the OPEN file: no window between the check and the read
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("the token file is not a regular file")
	}
	if st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("token file mode is %04o; it must be 0600", st.Mode().Perm())
	}
	if err := ownerOK(st); err != nil {
		return nil, err
	}
	if st.Size() > maxFile {
		return nil, errors.New("the token file is implausibly large")
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxFile+1))
	if err != nil {
		return nil, err
	}
	var d doc
	if err := json.Unmarshal(raw, &d); err != nil || d.Version != 1 || len(d.Tokens) > MaxRecords {
		return nil, errors.New("the token file is damaged")
	}
	seen := map[string]bool{}
	for _, r := range d.Tokens {
		if !validRecord(r) || seen[r.ID] {
			return nil, errors.New("the token file is damaged")
		}
		seen[r.ID] = true
	}
	return d.Tokens, nil
}

// update is read-modify-write under an flock, atomic: temp file (0600, O_EXCL) + fsync +
// rename + fsync of the directory. A concurrent reader sees the old file or the new one.
func update(state string, mutate func(*[]Record) error) error {
	if err := os.MkdirAll(state, 0o700); err != nil {
		return pathless(err)
	}
	if err := checkDir(state); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(state, LockName), os.O_WRONLY|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return pathless(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	recs, err := readFile(state)
	if err != nil {
		return err
	}
	if err := mutate(&recs); err != nil {
		return err
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].ID < recs[j].ID })
	body, err := json.MarshalIndent(doc{Version: 1, Tokens: nonNil(recs)}, "", " ")
	if err != nil {
		return err
	}
	tmp, err := os.OpenFile(filepath.Join(state, fmt.Sprintf(".%s.%d.%x", FileName, os.Getpid(), time.Now().UnixNano())),
		os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return pathless(err)
	}
	name := tmp.Name()
	if err := tmp.Chmod(0o600); err == nil {
		_, err = tmp.Write(append(body, '\n'))
		if err == nil {
			err = tmp.Sync()
		}
		if cerr := tmp.Close(); err == nil {
			err = cerr
		}
	} else {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, filepath.Join(state, FileName)); err != nil {
		os.Remove(name)
		return pathless(err)
	}
	if d, err := os.Open(state); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return nil
}

func nonNil(r []Record) []Record {
	if r == nil {
		return []Record{}
	}
	return r
}

var auditClean = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._@:-]{0,63}$`)

// audit appends one JSON line: an event, an id and fixed-vocabulary fields. Never a secret.
// Best effort: a failure here is reported on stderr by the caller, never fatal to a mint.
func audit(state, event, id string, fields map[string]any) error {
	rec := map[string]any{"ts": time.Now().Unix(), "event": event, "id": "-"}
	if idRE.MatchString(id) {
		rec["id"] = id
	}
	for k, v := range fields {
		switch x := v.(type) {
		case int64, int:
			rec[k] = x
		default:
			s := fmt.Sprint(x)
			if !auditClean.MatchString(s) {
				s = "-"
			}
			rec[k] = s
		}
	}
	b, err := json.Marshal(rec) // map keys are sorted
	if err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(state, AuditName), os.O_WRONLY|os.O_APPEND|os.O_CREATE|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return pathless(err)
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

// Digest is the SHA-256 hex of a secret, the only thing stored.
func Digest(secret string) string {
	h := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(h[:])
}

// Create mints a token. The returned string is the only place the secret exists.
func Create(state string, s Spec, env Env) (string, Public, error) {
	if err := validateSpec(s, env.KnownOp); err != nil {
		return "", Public{}, err
	}
	src := env.Rand
	if src == nil {
		src = rand.Reader
	}
	idb, sec := make([]byte, 8), make([]byte, 32)
	if _, err := io.ReadFull(src, idb); err != nil {
		return "", Public{}, err
	}
	if _, err := io.ReadFull(src, sec); err != nil {
		return "", Public{}, err
	}
	secret := base64.RawURLEncoding.EncodeToString(sec)
	now := env.now().Unix()
	rec := Record{ID: hex.EncodeToString(idb), Kind: s.Kind, Role: s.Role, Ops: append([]string(nil), s.Ops...),
		Created: now, Expires: now + int64(s.TTL/time.Second), Name: s.Name, Digest: Digest(secret)}
	err := update(state, func(recs *[]Record) error {
		if len(*recs) >= MaxRecords {
			return errors.New("too many tokens: revoke and prune some")
		}
		for _, r := range *recs {
			if r.ID == rec.ID {
				return errors.New("id collision: try again")
			}
		}
		*recs = append(*recs, rec)
		return nil
	})
	if err != nil {
		return "", Public{}, err
	}
	_ = audit(state, "create", rec.ID, map[string]any{"kind": s.Kind, "role": s.Role, "name": s.Name, "ttl": int64(s.TTL / time.Second)})
	pub := rec
	pub.Digest = ""
	return "bt_" + rec.ID + "." + secret, Public{Record: pub, Status: StatusOf(pub, env.now())}, nil
}

// Revoke marks a token revoked. did is false when it already was.
func Revoke(state, id string, env Env) (did bool, err error) {
	if !idRE.MatchString(id) {
		return false, errors.New("a token id is 16 hex characters (the part after bt_ and before the dot)")
	}
	found := false
	now := env.now().Unix()
	err = update(state, func(recs *[]Record) error {
		for i := range *recs {
			if (*recs)[i].ID == id {
				found = true
				if (*recs)[i].RevokedAt == nil {
					t := now
					(*recs)[i].RevokedAt = &t
					did = true
				}
			}
		}
		if !found {
			return fmt.Errorf("no token %s", id)
		}
		return nil
	})
	if err == nil && did {
		_ = audit(state, "revoke", id, nil)
	}
	return did, err
}

// List returns every record, oldest first, without digests.
func List(state string, env Env) ([]Public, error) {
	recs, err := readFile(state)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].Created < recs[j].Created })
	out := make([]Public, 0, len(recs))
	for _, r := range recs {
		r.Digest = ""
		out = append(out, Public{Record: r, Status: StatusOf(r, env.now())})
	}
	return out, nil
}
