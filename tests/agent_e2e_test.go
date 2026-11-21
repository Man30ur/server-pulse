package tests

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type metricsResp struct {
	Timestamp int64  `json:"timestamp"`
	Hostname  string `json:"hostname"`
	UptimeSec int64  `json:"uptime_sec"`
	CPU       struct {
		Percent float64 `json:"percent"`
		Cores   int     `json:"cores"`
	} `json:"cpu"`
	Memory struct {
		UsedMB      int64   `json:"used_mb"`
		TotalMB     int64   `json:"total_mb"`
		Percent     float64 `json:"percent"`
		SwapUsedMB  int64   `json:"swap_used_mb"`
		SwapTotalMB int64   `json:"swap_total_mb"`
	} `json:"memory"`
	Disk struct {
		UsedGB  float64 `json:"used_gb"`
		TotalGB float64 `json:"total_gb"`
		Percent float64 `json:"percent"`
	} `json:"disk"`
	Containers []struct {
		ID         string  `json:"id"`
		Name       string  `json:"name"`
		State      string  `json:"state"`
		CPUPercent float64 `json:"cpu_percent"`
		MemMB      float64 `json:"mem_mb"`
		MemPercent float64 `json:"mem_percent"`
	} `json:"containers"`
	Processes []struct {
		PID        int     `json:"pid"`
		Name       string  `json:"name"`
		CPUPercent float64 `json:"cpu_percent"`
		MemMB      float64 `json:"mem_mb"`
	} `json:"processes"`
}

func startMockDocker(t *testing.T, sockPath string, listHits *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/containers/json", func(w http.ResponseWriter, _ *http.Request) {
		listHits.Add(1)
		_, _ = w.Write([]byte(`[
			{"Id":"8c83357c95e6abcdef","Names":["/front-stox"],"State":"running"},
			{"Id":"111122223333444455","Names":["/old-job"],"State":"exited"}
		]`))
	})
	mux.HandleFunc("/containers/8c83357c95e6abcdef/stats", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"cpu_stats":{"cpu_usage":{"total_usage":200},"system_cpu_usage":2000,"online_cpus":2},
			"precpu_stats":{"cpu_usage":{"total_usage":150},"system_cpu_usage":1000,"online_cpus":2},
			"memory_stats":{"usage":524288000,"limit":1073741824,"stats":{"inactive_file":104857600}}
		}`))
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
}

func setupMockProc(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	mustWrite := func(rel, content string) {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite("stat", "cpu  200 0 100 700 0 0 0 0 0 0\ncpu0 100 0 50 350 0 0 0 0 0 0\ncpu1 100 0 50 350 0 0 0 0 0 0\n")
	mustWrite("meminfo", "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\nSwapTotal:       8388608 kB\nSwapFree:        8388608 kB\n")
	mustWrite("uptime", "86400.42 12345.00\n")
	mustWrite("1245/stat", "1245 (java) S 1 1 1 0 -1 0 0 0 0 0 50 10 0 0 20 0 1 0 100 0 131072 0\n")
	mustWrite("1245/cgroup", "0::/system.slice/java.service\n")
	mustWrite("2001/stat", "2001 (node) S 1 1 1 0 -1 0 0 0 0 0 10 5 0 0 20 0 1 0 100 0 65536 0\n")
	mustWrite("2001/cgroup", "0::/system.slice/docker-8c83357c95e6.scope\n")
	return dir
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func readRSSMB(pid int) (float64, error) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "VmRSS:") {
			fields := strings.Fields(sc.Text())
			if len(fields) >= 2 {
				kb, err := strconv.ParseFloat(fields[1], 64)
				return kb / 1024.0, err
			}
		}
	}
	return 0, fmt.Errorf("VmRSS not found")
}

func TestAgentEndToEnd(t *testing.T) {
	binPath := filepath.Join(t.TempDir(), "server-pulse")
	buildCmd := exec.Command("go", "build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w", "-o", binPath, ".")
	buildCmd.Dir = filepath.Join("..", "agent")
	buildCmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("build failed: %v\n%s", err, string(out))
	}

	sockPath := filepath.Join(t.TempDir(), "docker.sock")
	var dockerHits atomic.Int32
	startMockDocker(t, sockPath, &dockerHits)

	procDir := setupMockProc(t)
	port := freePort(t)
	token := "test-bearer-token-e2e-64chars"

	cmd := exec.Command(binPath)
	cmd.Env = append(os.Environ(),
		"PULSE_BIND=127.0.0.1",
		fmt.Sprintf("PULSE_PORT=%d", port),
		"PULSE_TOKEN="+token,
		"PULSE_CACHE_TTL_MS=2500",
		"PULSE_HOSTNAME=demo-node-1",
		"PULSE_PROC_ROOT="+procDir,
		"DOCKER_SOCKET="+sockPath,
	)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start agent: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	client := &http.Client{Timeout: 2 * time.Second}

	ready := false
	for i := 0; i < 30; i++ {
		if resp, err := client.Get(baseURL + "/health"); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		t.Fatal("agent did not become healthy")
	}

	// Verify -healthcheck CLI mode
	hcCmd := exec.Command(binPath, "-healthcheck")
	hcCmd.Env = append(os.Environ(), fmt.Sprintf("PULSE_PORT=%d", port))
	if err := hcCmd.Run(); err != nil {
		t.Fatalf("-healthcheck failed: %v", err)
	}

	// Verify 401 without token
	resp, err := client.Get(baseURL + "/api/metrics")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", resp.StatusCode)
	}

	// Verify 200 with valid Bearer token + Chrome extension CORS
	fetch := func() metricsResp {
		req, _ := http.NewRequest(http.MethodGet, baseURL+"/api/metrics", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Origin", "chrome-extension://test-ext-id")
		r, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("expected 200, got %d", r.StatusCode)
		}
		if r.Header.Get("Access-Control-Allow-Origin") != "chrome-extension://test-ext-id" {
			t.Fatalf("missing CORS header")
		}
		var m metricsResp
		if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
			t.Fatal(err)
		}
		return m
	}

	first := fetch()
	if first.Hostname != "demo-node-1" || first.UptimeSec != 86400 || first.CPU.Cores != 2 {
		t.Fatalf("unexpected host/cpu: %+v", first)
	}
	if first.Memory.TotalMB != 16000 || first.Memory.UsedMB != 8000 || first.Disk.TotalGB <= 0 {
		t.Fatalf("unexpected mem/disk: %+v", first)
	}
	if len(first.Containers) != 2 || first.Containers[0].Name != "front-stox" || first.Containers[0].MemMB != 400.0 || first.Containers[0].CPUPercent != 10.0 {
		t.Fatalf("unexpected containers: %+v", first.Containers)
	}
	if len(first.Processes) != 1 || first.Processes[0].Name != "java" {
		t.Fatalf("expected only non-container proc java, got: %+v", first.Processes)
	}

	// Second call within 2.5s TTL must hit cache (dockerHits stays 1)
	second := fetch()
	if second.Timestamp != first.Timestamp || dockerHits.Load() != 1 {
		t.Fatalf("cache miss within TTL: ts1=%d ts2=%d hits=%d", first.Timestamp, second.Timestamp, dockerHits.Load())
	}

	// Verify binary RSS memory < 15 MB
	rssMB, err := readRSSMB(cmd.Process.Pid)
	if err != nil {
		t.Fatalf("readRSSMB: %v", err)
	}
	t.Logf("agent runtime VmRSS = %.2f MB", rssMB)
	if rssMB >= 15.0 {
		t.Fatalf("RSS memory %.2f MB exceeded 15 MB budget", rssMB)
	}
}
