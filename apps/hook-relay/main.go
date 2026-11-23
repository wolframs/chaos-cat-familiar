// ccf-hook-relay: an always-on stand-in for CCF's hook server, for Claude Code's routine http hooks.
//
// Claude Code shows "<event> hook error / connect ECONNREFUSED" in every session for every http hook that fails,
// and offers no way to hide it. CCF is an app the operator closes at will, so pointing the hooks straight at it
// filled every transcript with those notices whenever it was closed (2026-11-02). The relay is tiny and started at
// logon: it answers each POST /hook with 200 {} at once and forwards the event to CCF in arrival order; when CCF is
// not listening the event is dropped, silently. Only the routine events come here; PermissionRequest, SessionStart
// and UserPromptSubmit stay command hooks (the sender exits 0 when CCF is down).
//
// The relay does no authentication of its own: it passes the X-Ccf-Token header on unchanged and CCF checks it.
// Like CCF, it refuses requests whose Host is not its own loopback address or that carry an Origin header, so a
// browser page cannot use it.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const (
	maxBody   = 2 << 20
	queueSize = 512
)

type event struct {
	body  []byte
	token string
}

type relay struct {
	queue     chan event
	target    func() string // CCF base URL, e.g. http://127.0.0.1:49152
	client    *http.Client
	host      string // expected Host header
	logf      func(string, ...any)
	mu        sync.Mutex
	lastError string
}

func (r *relay) enqueue(e event) {
	for {
		select {
		case r.queue <- e:
			return
		default:
			// Full: CCF is slow or the forwarder is stuck. Keep the newest events.
			select {
			case <-r.queue:
			default:
			}
		}
	}
}

func (r *relay) forward() {
	for e := range r.queue {
		req, err := http.NewRequest(http.MethodPost, r.target()+"/hook", bytes.NewReader(e.body))
		if err != nil {
			continue
		}
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		if e.token != "" {
			req.Header.Set("X-Ccf-Token", e.token)
		}
		resp, err := r.client.Do(req)
		msg := ""
		if err != nil {
			if !isRefused(err) {
				msg = "forward failed: " + err.Error()
			}
		} else {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 300 {
				msg = "CCF answered " + resp.Status
			}
		}
		// Log a failure once per change, not per event: CCF being closed is normal and stays silent.
		r.mu.Lock()
		if msg != r.lastError {
			if msg != "" {
				r.logf("%s", msg)
			}
			r.lastError = msg
		}
		r.mu.Unlock()
	}
}

func isRefused(err error) bool {
	var op *net.OpError
	for e := err; e != nil; {
		if o, ok := e.(*net.OpError); ok {
			op = o
			break
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			break
		}
		e = u.Unwrap()
	}
	return op != nil && op.Op == "dial"
}

func (r *relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.Host != r.host || req.Header.Get("Origin") != "" {
		w.WriteHeader(http.StatusForbidden)
		return
	}
	switch {
	case req.Method == http.MethodGet && req.URL.Path == "/health":
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "ok")
	case req.Method == http.MethodPost && req.URL.Path == "/hook":
		body, err := io.ReadAll(io.LimitReader(req.Body, maxBody+1))
		if err != nil || len(body) > maxBody {
			// Still 200: a hook error notice is exactly what the relay exists to avoid.
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, "{}")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, "{}")
		r.enqueue(event{body: body, token: req.Header.Get("X-Ccf-Token")})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// ccfTarget returns CCF's base URL from its settings.json ("port"), re-read when the file changes.
func ccfTarget(settingsPath string) func() string {
	var mu sync.Mutex
	var stamp time.Time
	url := "http://127.0.0.1:49152"
	return func() string {
		mu.Lock()
		defer mu.Unlock()
		fi, err := os.Stat(settingsPath)
		if err != nil || fi.ModTime().Equal(stamp) {
			return url
		}
		stamp = fi.ModTime()
		b, err := os.ReadFile(settingsPath)
		if err != nil {
			return url
		}
		var s struct {
			Port int `json:"port"`
		}
		if json.Unmarshal(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), &s) == nil && s.Port > 0 && s.Port < 65536 {
			url = "http://127.0.0.1:" + strconv.Itoa(s.Port)
		}
		return url
	}
}

func newLogger(path string) func(string, ...any) {
	var mu sync.Mutex
	return func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		if fi, err := os.Stat(path); err == nil && fi.Size() > 1<<20 {
			os.Rename(path, path+".1")
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return
		}
		defer f.Close()
		fmt.Fprintf(f, "%s [%d] %s\n", time.Now().Format(time.RFC3339), os.Getpid(), fmt.Sprintf(format, args...))
	}
}

func main() {
	port := flag.Int("port", 49151, "loopback port to listen on")
	settings := flag.String("settings", filepath.Join(os.Getenv("APPDATA"), "chaos-cat-familiar", "settings.json"), "CCF settings.json (port)")
	logPath := flag.String("log", filepath.Join(os.Getenv("LOCALAPPDATA"), "chaos-cat-familiar-relay", "relay.log"), "log file")
	flag.Parse()
	os.MkdirAll(filepath.Dir(*logPath), 0o755)
	logf := newLogger(*logPath)

	addr := "127.0.0.1:" + strconv.Itoa(*port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Another relay holds the port (the listen is the single-instance lock), or the port is taken.
		logf("cannot listen on %s: %v", addr, err)
		os.Exit(1)
	}
	r := &relay{
		queue:  make(chan event, queueSize),
		target: ccfTarget(*settings),
		client: &http.Client{Timeout: 2 * time.Second},
		host:   addr,
		logf:   logf,
	}
	go r.forward()
	logf("listening on %s, forwarding to CCF per %s", addr, *settings)
	srv := &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second}
	logf("server stopped: %v", srv.Serve(ln))
	os.Exit(1)
}
