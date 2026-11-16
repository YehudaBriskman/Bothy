// Package config stores contexts: named boxes (a base URL and, optionally,
// where to read a token from). The file is XDG_CONFIG_HOME/bothy/config.json,
// mode 0600 in a 0700 directory. A token itself is never stored in it: a
// context points at a token file, or the BOTHY_TOKEN variable is used.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Context is one box.
type Context struct {
	URL       string `json:"url"`
	TokenFile string `json:"token_file,omitempty"`
}

// File is the on-disk document.
type File struct {
	Current  string             `json:"current,omitempty"`
	Contexts map[string]Context `json:"contexts"`
}

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// Path returns the config file path.
func Path() (string, error) {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "bothy", "config.json"), nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".config", "bothy", "config.json"), nil
}

// Load reads the config; a missing file is an empty config. A file readable
// by group or others is refused: the file names token files.
func Load() (*File, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(p)
	if errors.Is(err, os.ErrNotExist) {
		return &File{Contexts: map[string]Context{}}, nil
	}
	if err != nil {
		return nil, err
	}
	if st.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%s is mode %04o, expected 0600: run chmod 600 on it", p, st.Mode().Perm())
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	if f.Contexts == nil {
		f.Contexts = map[string]Context{}
	}
	return &f, nil
}

// Save writes the config atomically with mode 0600.
func (f *File) Save() error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".config-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// Add registers a context. The first one added becomes current.
func (f *File) Add(name string, c Context) error {
	if !nameRE.MatchString(name) {
		return fmt.Errorf("context name %q must match %s", name, nameRE)
	}
	u, err := url.Parse(c.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("url %q must be http:// or https:// with a host", c.URL)
	}
	if f.Contexts == nil {
		f.Contexts = map[string]Context{}
	}
	f.Contexts[name] = c
	if f.Current == "" {
		f.Current = name
	}
	return nil
}

// Use selects the current context.
func (f *File) Use(name string) error {
	if _, ok := f.Contexts[name]; !ok {
		return fmt.Errorf("no context %q (have: %s)", name, strings.Join(f.Names(), ", "))
	}
	f.Current = name
	return nil
}

// Names lists context names, sorted.
func (f *File) Names() []string {
	n := make([]string, 0, len(f.Contexts))
	for k := range f.Contexts {
		n = append(n, k)
	}
	sort.Strings(n)
	return n
}

// ReadToken returns the token for c: BOTHY_TOKEN if set, else the first line
// of the token file (which must not be readable by group or others), else "".
func ReadToken(c Context, getenv func(string) string) (string, error) {
	if t := strings.TrimSpace(getenv("BOTHY_TOKEN")); t != "" {
		return t, nil
	}
	if c.TokenFile == "" {
		return "", nil
	}
	st, err := os.Stat(c.TokenFile)
	if err != nil {
		return "", fmt.Errorf("token file: %w", err)
	}
	if st.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("token file %s is mode %04o, expected 0600", c.TokenFile, st.Mode().Perm())
	}
	b, err := os.ReadFile(c.TokenFile)
	if err != nil {
		return "", fmt.Errorf("token file: %w", err)
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(b)), "\n")
	return strings.TrimSpace(line), nil
}
