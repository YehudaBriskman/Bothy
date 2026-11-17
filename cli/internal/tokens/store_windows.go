//go:build windows

package tokens

func Digest(string) string { return "" }

func Create(string, Spec, Env) (string, Public, error) { return "", Public{}, ErrUnsupported }

func Revoke(string, string, Env) (bool, error) { return false, ErrUnsupported }

func List(string, Env) ([]Public, error) { return nil, ErrUnsupported }
