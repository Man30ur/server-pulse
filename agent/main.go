package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MetricsCache provides thread-safe TTL caching with single-flight coalescing.
type MetricsCache struct {
	ttl     time.Duration
	collect func(ctx context.Context) ([]byte, error)

	mu       sync.Mutex
	cached   []byte
	cachedAt time.Time
	inflight chan struct{}
}

func NewMetricsCache(ttl time.Duration, collect func(ctx context.Context) ([]byte, error)) *MetricsCache {
	return &MetricsCache{ttl: ttl, collect: collect}
}

func (c *MetricsCache) Get(ctx context.Context) ([]byte, error) {
	for {
		c.mu.Lock()
		if len(c.cached) > 0 && c.ttl > 0 && time.Since(c.cachedAt) < c.ttl {
			data := c.cached
			c.mu.Unlock()
			return data, nil
		}
		if c.inflight != nil {
			ch := c.inflight
			c.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ch := make(chan struct{})
		c.inflight = ch
		c.mu.Unlock()

		collectCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		data, err := c.collect(collectCtx)
		cancel()

		c.mu.Lock()
		if err == nil {
			c.cached = data
			c.cachedAt = time.Now()
		}
		c.inflight = nil
		close(ch)
		c.mu.Unlock()

		return data, err
	}
}

func checkBearerToken(header, expected string) bool {
	if expected == "" || !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	got := header[len("Bearer "):]
	return subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1
}

func withSecurityAndCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Cache-Control", "no-store")

		origin := r.Header.Get("Origin")
		if strings.HasPrefix(origin, "chrome-extension://") {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization")
			w.Header().Set("Access-Control-Max-Age", "600")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func NewHandler(cfg Config, sys *SysCollector, docker *DockerCollector) http.Handler {
	cache := NewMetricsCache(cfg.CacheTTL, func(ctx context.Context) ([]byte, error) {
		host := sys.Collect()
		containers := docker.Collect(ctx, host.MemTotalBytes)
		if containers == nil {
			containers = []ContainerMetric{}
		}
		procs := host.Processes
		if procs == nil {
			procs = []ProcessMetric{}
		}
		cpuProcs := host.CPUProcesses
		if cpuProcs == nil {
			cpuProcs = []ProcessMetric{}
		}
		disks := host.Disks
		if disks == nil {
			disks = []MountMetric{}
		}
		payload := MetricsPayload{
			Timestamp:    time.Now().Unix(),
			Hostname:     cfg.Hostname,
			UptimeSec:    host.UptimeSec,
			CPU:          host.CPU,
			Memory:       host.Memory,
			Disk:         host.Disk,
			Disks:        disks,
			DockerDisk:   docker.CollectDF(),
			Load:         host.Load,
			Network:      host.Network,
			DiskIO:       host.DiskIO,
			Containers:   containers,
			Processes:    procs,
			CPUProcesses: cpuProcs,
		}
		return json.Marshal(payload)
	})

	mux := http.NewServeMux()
	registerWebUI(mux)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		if !checkBearerToken(r.Header.Get("Authorization"), cfg.Token) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
			return
		}
		data, err := cache.Get(r.Context())
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"metrics_unavailable"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
	})

	return withSecurityAndCORS(mux)
}

func runHealthcheck(port string) int {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	cfg := loadConfig()
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(runHealthcheck(cfg.Port))
	}
	if cfg.Token == "" {
		log.Fatal("server-pulse: PULSE_TOKEN is required")
	}

	sys := NewSysCollector(cfg.ProcRoot, cfg.DiskPath, cfg.TopProcesses)
	docker := NewDockerCollector(cfg.DockerSocket)

	srv := &http.Server{
		Addr:              cfg.Bind + ":" + cfg.Port,
		Handler:           NewHandler(cfg, sys, docker),
		ReadHeaderTimeout: 3 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("server-pulse listening on %s (cache=%s)", srv.Addr, cfg.CacheTTL)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server-pulse listen error: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
