package api_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/YehudaBriskman/Bothy/cli/internal/api"
	"github.com/YehudaBriskman/Bothy/cli/internal/catalog"
)

func secretHalf(tok string) string { return tok[strings.IndexByte(tok, '.')+1:] }

// A box (or a proxy, or a debug page) that echoes the credential back must not get it onto
// the terminal: not in an error, not in data, not in a header the client shows.
func TestTokenIsRedactedFromEveryResponseText(t *testing.T) {
	for _, mode := range []string{"error", "data", "header", "protocol"} {
		t.Run(mode, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				echo := r.Header.Get("Authorization")
				switch mode {
				case "error":
					fmt.Fprintf(w, `{"ok":false,"request_id":"r","error":{"code":"request.invalid","message":%q,"hint":%q,"details":{"h":%q}}}`,
						"saw "+echo, "again "+secretHalf(goodTok), echo)
				case "data":
					fmt.Fprintf(w, `{"ok":true,"data":{"apiVersion":%d,"ops":[],"note":%q}}`, catalog.APIVersion, echo)
				case "header":
					w.Header().Set("Bothy-Server", "v9 api=1 min-client=0.0.0 "+secretHalf(goodTok))
					fmt.Fprint(w, `{"ok":false,"error":{"code":"x.y","message":"m"}}`)
				case "protocol":
					fmt.Fprint(w, "not json "+echo)
				}
			}))
			defer srv.Close()
			c, err := api.New(srv.URL, goodTok, "dev", 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			_, res, err := c.Discover(context.Background())
			text := fmt.Sprintf("%v|%+v", err, res)
			if res != nil {
				text += string(res.Data)
			}
			if ae, ok := err.(*api.Error); ok {
				text += fmt.Sprintf("%s|%s|%v", ae.Message, ae.Hint, ae.Details)
			}
			if strings.Contains(text, goodTok) || strings.Contains(text, secretHalf(goodTok)) {
				t.Fatalf("the token leaked: %s", text)
			}
		})
	}
}

func TestMalformedTokenIsRefusedAndNeverEchoed(t *testing.T) {
	for _, bad := range []string{"x", "bt_1.2", goodTok + "\r\nX-Evil: 1", goodTok + " ", "Bearer " + goodTok, strings.Replace(goodTok, "bt_", "xx_", 1)} {
		_, err := api.New("http://127.0.0.1:1", bad, "dev", 0)
		if err == nil {
			t.Errorf("%q accepted", bad)
			continue
		}
		if strings.Contains(err.Error(), bad) || strings.Contains(err.Error(), secretHalf(goodTok)) {
			t.Errorf("error echoes the token: %v", err)
		}
	}
}

func TestNoTokenMeansNoAuthorizationHeader(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		fmt.Fprintf(w, `{"ok":true,"data":{"apiVersion":%d,"ops":[]}}`, catalog.APIVersion)
	}))
	defer srv.Close()
	c, _ := api.New(srv.URL, "", "dev", 0)
	if _, _, err := c.Discover(context.Background()); err != nil || got != "" {
		t.Fatalf("err=%v header=%q", err, got)
	}
}
