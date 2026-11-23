package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestRelay(target string) *relay {
	return &relay{
		queue:  make(chan event, queueSize),
		target: func() string { return target },
		client: &http.Client{Timeout: 2 * time.Second},
		host:   "127.0.0.1:49151",
		logf:   func(string, ...any) {},
	}
}

func post(t *testing.T, r *relay, body string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:49151/hook", strings.NewReader(body))
	req.Host = "127.0.0.1:49151"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAnswersAtOnceWhenCcfIsDown(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := "http://" + ln.Addr().String()
	ln.Close() // nothing listens there any more
	r := newTestRelay(dead)
	go r.forward()
	start := time.Now()
	w := post(t, r, `{"hook_event_name":"PreToolUse"}`, nil)
	if w.Code != 200 || w.Body.String() != "{}" {
		t.Fatalf("got %d %q", w.Code, w.Body.String())
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatalf("answer took %v", time.Since(start))
	}
}

func TestForwardsInOrderWithToken(t *testing.T) {
	var mu sync.Mutex
	var got []string
	var tokens []string
	ccf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		mu.Lock()
		got = append(got, string(b))
		tokens = append(tokens, req.Header.Get("X-Ccf-Token"))
		mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	defer ccf.Close()
	r := newTestRelay(ccf.URL)
	go r.forward()
	for _, n := range []string{"1", "2", "3"} {
		post(t, r, `{"n":`+n+`}`, map[string]string{"X-Ccf-Token": "secret"})
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		if n == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(got, ",") != `{"n":1},{"n":2},{"n":3}` {
		t.Fatalf("order/bodies: %v", got)
	}
	for _, tk := range tokens {
		if tk != "secret" {
			t.Fatalf("token not passed on: %v", tokens)
		}
	}
}

func TestRefusesForeignHostAndOrigin(t *testing.T) {
	r := newTestRelay("http://127.0.0.1:1")
	req := httptest.NewRequest(http.MethodPost, "http://evil.example/hook", strings.NewReader("{}"))
	req.Host = "evil.example:49151"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("foreign host: %d", w.Code)
	}
	if w := post(t, r, "{}", map[string]string{"Origin": "https://example.com"}); w.Code != http.StatusForbidden {
		t.Fatalf("origin: %d", w.Code)
	}
}

func TestQueueFullKeepsNewest(t *testing.T) {
	r := newTestRelay("http://127.0.0.1:1")
	r.queue = make(chan event, 2)
	for _, b := range []string{"a", "b", "c"} {
		r.enqueue(event{body: []byte(b)})
	}
	first, second := string((<-r.queue).body), string((<-r.queue).body)
	if first != "b" || second != "c" {
		t.Fatalf("kept %s,%s", first, second)
	}
}
