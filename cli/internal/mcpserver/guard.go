package mcpserver

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"sync"
)

// maxFrame bounds one inbound JSON-RPC line. Requests to a read-only server
// are tiny (a tool name and a few short strings), so 1 MiB is generous and
// keeps a hostile peer from making the process buffer 16 MiB (the SDK's own
// default) per frame.
const maxFrame = 1 << 20

// The SDK ends the whole session on the first inbound frame it cannot parse
// (JSON-RPC says to answer -32700 and carry on). guard sits between the raw
// stream and the SDK: a line that is not a JSON object, or a non-empty array
// of objects, or is larger than maxFrame, is answered here with the standard
// error and never reaches the SDK, so one bad frame cannot take the server
// down. Everything valid is passed through unchanged.
type guard struct {
	mu  sync.Mutex // serialises writes to out: the SDK's replies and ours
	out io.WriteCloser
}

func (g *guard) Write(p []byte) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.out.Write(p)
}

func (g *guard) Close() error { return g.out.Close() }

func (g *guard) reply(code int, msg string) {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": nil, "error": map[string]any{"code": code, "message": msg}})
	_, _ = g.Write(append(b, '\n'))
}

// filter copies well-formed frames from in to w, one per line, and answers the rest.
// It closes w when in ends.
func (g *guard) filter(in io.Reader, w *io.PipeWriter) {
	br := bufio.NewReaderSize(in, 64<<10)
	for {
		line, tooBig, err := readFrame(br)
		switch {
		case tooBig:
			g.reply(-32600, "frame too large")
		case len(bytes.TrimSpace(line)) == 0:
		case !validFrame(line):
			g.reply(-32700, "parse error: a frame must be one JSON object (or an array of them) per line")
		default:
			if _, werr := w.Write(append(bytes.TrimSpace(line), '\n')); werr != nil {
				return
			}
		}
		if err != nil {
			_ = w.Close()
			return
		}
	}
}

// readFrame reads one line of at most maxFrame bytes. Past the limit it keeps
// reading and discarding to the end of the line and reports tooBig.
func readFrame(br *bufio.Reader) (line []byte, tooBig bool, err error) {
	for {
		chunk, e := br.ReadSlice('\n')
		if !tooBig {
			if len(line)+len(chunk) > maxFrame {
				tooBig, line = true, nil
			} else {
				line = append(line, chunk...)
			}
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		return line, tooBig, e
	}
}

func validFrame(b []byte) bool {
	b = bytes.TrimSpace(b)
	if !json.Valid(b) {
		return false
	}
	switch b[0] {
	case '{':
		return true
	case '[':
		var items []json.RawMessage
		if json.Unmarshal(b, &items) != nil || len(items) == 0 {
			return false
		}
		for _, it := range items {
			if t := bytes.TrimSpace(it); len(t) == 0 || t[0] != '{' {
				return false
			}
		}
		return true
	}
	return false
}
