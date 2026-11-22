package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCheckBearerToken(t *testing.T) {
	if !checkBearerToken("Bearer secret123", "secret123") {
		t.Fatal("expected valid bearer token to pass")
	}
	for _, hdr := range []string{"", "secret123", "Basic secret123", "Bearer wrong", "Bearer secret12"} {
		if checkBearerToken(hdr, "secret123") {
			t.Fatalf("expected header %q to be rejected", hdr)
		}
	}
	if checkBearerToken("Bearer ", "") {
		t.Fatal("expected empty expected token to be rejected")
	}
}

func TestReadMemInfoAndCPUStat(t *testing.T) {
	dir := t.TempDir()
	memPath := filepath.Join(dir, "meminfo")
	memData := "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       4096000 kB\nSwapFree:        3072000 kB\n"
	if err := os.WriteFile(memPath, []byte(memData), 0o600); err != nil {
		t.Fatal(err)
	}
	mem, totalBytes := readMemInfo(memPath)
	if mem.TotalMB != 16000 || mem.UsedMB != 8000 || mem.Percent != 50.0 {
		t.Fatalf("unexpected mem: %+v", mem)
	}
	if mem.SwapTotalMB != 4000 || mem.SwapUsedMB != 1000 {
		t.Fatalf("unexpected swap: %+v", mem)
	}
	if totalBytes != 16384000*1024 {
		t.Fatalf("unexpected totalBytes: %d", totalBytes)
	}

	statPath := filepath.Join(dir, "stat")
	statData := "cpu  100 0 50 850 0 0 0 0 0 0\ncpu0 50 0 25 425 0 0 0 0 0 0\ncpu1 50 0 25 425 0 0 0 0 0 0\n"
	if err := os.WriteFile(statPath, []byte(statData), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := readCPUStat(statPath)
	if err != nil {
		t.Fatal(err)
	}
	if s.cores != 2 || s.total != 1000 || s.idle != 850 {
		t.Fatalf("unexpected cpuSample: %+v", s)
	}
}

func TestReadProcStatWithParensInComm(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "stat")
	// Fields: 1=pid 2=(comm) 3=S ... 14=utime(120) 15=stime(30) ... 24=rss(2560)
	line := "42 (my (app) proc) S 1 1 1 0 -1 0 0 0 0 0 120 30 0 0 20 0 1 0 100 0 2560 0\n"
	if err := os.WriteFile(p, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}
	name, ticks, rss, ok := readProcStat(p)
	if !ok || name != "my (app) proc" || ticks != 150 || rss != 2560 {
		t.Fatalf("got name=%q ticks=%d rss=%d ok=%v", name, ticks, rss, ok)
	}
}

func TestContainerMemAndCPU(t *testing.T) {
	mb, pct := calcContainerMem(dockerMemStats{
		Usage: 500 * 1024 * 1024,
		Limit: 1000 * 1024 * 1024,
		Stats: map[string]uint64{"inactive_file": 100 * 1024 * 1024},
	}, 2000*1024*1024)
	if round1(mb) != 400.0 || round1(pct) != 40.0 {
		t.Fatalf("unexpected container mem: mb=%.2f pct=%.2f", mb, pct)
	}

	dc := NewDockerCollector("")
	st := dockerStatsResp{}
	st.PreCPUStats.CPUUsage.TotalUsage = 100
	st.PreCPUStats.SystemUsage = 1000
	st.CPUStats.CPUUsage.TotalUsage = 200
	st.CPUStats.SystemUsage = 2000
	st.CPUStats.OnlineCPUs = 4
	cpu := round1(dc.calcCPU("abc", st))
	if cpu != 40.0 {
		t.Fatalf("expected 40.0%% CPU, got %.1f", cpu)
	}
}

func TestMetricsCacheSingleFlightAndTTL(t *testing.T) {
	var calls atomic.Int32
	cache := NewMetricsCache(200*time.Millisecond, func(_ context.Context) ([]byte, error) {
		calls.Add(1)
		time.Sleep(30 * time.Millisecond)
		return []byte(`{"ok":true}`), nil
	})

	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			data, err := cache.Get(context.Background())
			if err != nil || string(data) != `{"ok":true}` {
				t.Errorf("unexpected result: %q %v", string(data), err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("expected 1 single-flight call, got %d", calls.Load())
	}

	if _, err := cache.Get(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected cached hit, got %d calls", calls.Load())
	}
}

func TestWebUIServedWithoutAuthAndStrictCSP(t *testing.T) {
	cfg := Config{Token: "tok-xyz", CacheTTL: time.Second, Hostname: "test-host"}
	h := NewHandler(cfg, NewSysCollector(t.TempDir(), "/", 6), NewDockerCollector(""))

	for path, ctype := range map[string]string{
		"/":        "text/html",
		"/app.css": "text/css",
		"/app.js":  "application/javascript",
		"/view.js": "application/javascript",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), ctype) {
			t.Fatalf("%s: code=%d type=%q", path, rec.Code, rec.Header().Get("Content-Type"))
		}
		if !strings.Contains(rec.Header().Get("Content-Security-Policy"), "script-src 'self'") {
			t.Fatalf("%s: missing strict CSP", path)
		}
		if rec.Body.Len() == 0 {
			t.Fatalf("%s: empty body", path)
		}
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown path, got %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("API must stay protected, got %d", rec.Code)
	}
}

func TestHandlerAuthAndCORS(t *testing.T) {
	cfg := Config{Token: "tok-xyz", CacheTTL: time.Second, Hostname: "test-host"}
	h := NewHandler(cfg, NewSysCollector(t.TempDir(), "/", 6), NewDockerCollector(""))

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Body.String() != `{"ok":true}` {
		t.Fatalf("health failed: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodOptions, "/api/metrics", nil)
	req.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || rec.Header().Get("Access-Control-Allow-Origin") != "chrome-extension://abcdefghijklmnop" {
		t.Fatalf("CORS preflight failed: %d hdr=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}

	req = httptest.NewRequest(http.MethodGet, "/api/metrics", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("expected 401 and no CORS for non-extension origin: %d", rec.Code)
	}
}
