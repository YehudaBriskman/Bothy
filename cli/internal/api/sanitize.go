package api

import (
	"strings"
	"unicode"
)

// Sanitize makes server text safe to print on a terminal or hand to a model.
// The server already strips these (golden README rule 4); this is the second
// lock, because a client must not trust that a proxy or an older server did.
//
// It removes: C0 controls except newline and tab, DEL, C1 controls, ANSI CSI/
// OSC/DCS/APC/PM/SOS escape sequences (the whole sequence, not just ESC),
// bidi overrides and isolates, zero-width and BOM characters, and U+2028/2029.
func Sanitize(s string) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == 0x1b:
			i = skipEscape(rs, i)
		case r == 0x9b: // 8-bit CSI
			i = skipCSI(rs, i+1)
		case r >= 0x90 && r <= 0x9f && (r == 0x90 || r == 0x98 || r == 0x9d || r == 0x9e || r == 0x9f):
			i = skipString(rs, i+1)
		case r == '\n' || r == '\t':
			b.WriteRune(r)
		case r < 0x20, r == 0x7f, r >= 0x80 && r <= 0x9f:
		case isBidiOrInvisible(r):
		case r == unicode.ReplacementChar:
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func isBidiOrInvisible(r rune) bool {
	switch {
	case r >= 0x202a && r <= 0x202e: // LRE RLE PDF LRO RLO
		return true
	case r >= 0x2066 && r <= 0x2069: // LRI RLI FSI PDI
		return true
	case r == 0x200e || r == 0x200f || r == 0x061c: // LRM RLM ALM
		return true
	case r >= 0x200b && r <= 0x200d, r == 0x2060, r == 0xfeff, r == 0x2028, r == 0x2029:
		return true
	}
	return false
}

// skipEscape returns the index of the last rune of the escape sequence that
// starts at rs[i] (an ESC).
func skipEscape(rs []rune, i int) int {
	if i+1 >= len(rs) {
		return i
	}
	switch rs[i+1] {
	case '[':
		return skipCSI(rs, i+2)
	case ']', 'P', 'X', '^', '_': // OSC, DCS, SOS, PM, APC: string until BEL or ST
		return skipString(rs, i+2)
	default:
		// two-character escape (ESC c, ESC 7, ...); intermediates 0x20-0x2f then a final
		j := i + 1
		for j < len(rs) && rs[j] >= 0x20 && rs[j] <= 0x2f {
			j++
		}
		if j < len(rs) {
			return j
		}
		return len(rs) - 1
	}
}

func skipCSI(rs []rune, from int) int {
	for j := from; j < len(rs); j++ {
		if rs[j] >= 0x40 && rs[j] <= 0x7e {
			return j
		}
	}
	return len(rs) - 1
}

func skipString(rs []rune, from int) int {
	for j := from; j < len(rs); j++ {
		if rs[j] == 0x07 || rs[j] == 0x9c {
			return j
		}
		if rs[j] == 0x1b && j+1 < len(rs) && rs[j+1] == '\\' {
			return j + 1
		}
	}
	return len(rs) - 1
}

// OneLine collapses newlines and tabs to single spaces, for table cells.
func OneLine(s string) string {
	return strings.Join(strings.Fields(Sanitize(s)), " ")
}
