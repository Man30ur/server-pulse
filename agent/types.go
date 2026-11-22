package main

import (
	"math"
	"os"
	"strconv"
	"strings"
	"time"
)

// MetricsPayload matches the exact JSON API contract in AI_CODEMAP.md.
type MetricsPayload struct {
	Timestamp  int64             `json:"timestamp"`
	Hostname   string            `json:"hostname"`
	UptimeSec  int64             `json:"uptime_sec"`
	CPU        CPUMetric         `json:"cpu"`
	Memory     MemoryMetric      `json:"memory"`
	Disk       DiskMetric        `json:"disk"`
	Load       [3]float64        `json:"load"`
	Network    NetMetric         `json:"network"`
	DiskIO     DiskIOMetric      `json:"disk_io"`
	Containers []ContainerMetric `json:"containers"`
	Processes  []ProcessMetric   `json:"processes"`
}

// NetMetric is host network throughput (bytes/sec) excluding loopback and Docker bridges.
type NetMetric struct {
	RxBps float64 `json:"rx_bps"`
	TxBps float64 `json:"tx_bps"`
}

// DiskIOMetric is host block-device throughput (bytes/sec) across whole disks.
type DiskIOMetric struct {
	ReadBps  float64 `json:"read_bps"`
	WriteBps float64 `json:"write_bps"`
}

// HostSnapshot groups all host-level readings produced by SysCollector.Collect.
type HostSnapshot struct {
	UptimeSec     int64
	CPU           CPUMetric
	Memory        MemoryMetric
	MemTotalBytes uint64
	Disk          DiskMetric
	Load          [3]float64
	Network       NetMetric
	DiskIO        DiskIOMetric
	Processes     []ProcessMetric
}

type CPUMetric struct {
	Percent float64 `json:"percent"`
	Cores   int     `json:"cores"`
}

type MemoryMetric struct {
	UsedMB      int64   `json:"used_mb"`
	TotalMB     int64   `json:"total_mb"`
	Percent     float64 `json:"percent"`
	SwapUsedMB  int64   `json:"swap_used_mb"`
	SwapTotalMB int64   `json:"swap_total_mb"`
}

type DiskMetric struct {
	UsedGB  float64 `json:"used_gb"`
	TotalGB float64 `json:"total_gb"`
	Percent float64 `json:"percent"`
}

type ContainerMetric struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	State      string  `json:"state"`
	Status     string  `json:"status"`
	Health     string  `json:"health"`
	CPUPercent float64 `json:"cpu_percent"`
	MemMB      float64 `json:"mem_mb"`
	MemPercent float64 `json:"mem_percent"`
}

type ProcessMetric struct {
	PID        int     `json:"pid"`
	Name       string  `json:"name"`
	CPUPercent float64 `json:"cpu_percent"`
	MemMB      float64 `json:"mem_mb"`
}

// Config holds runtime configuration loaded from environment variables.
type Config struct {
	Bind         string
	Port         string
	Token        string
	CacheTTL     time.Duration
	TopProcesses int
	DockerSocket string
	ProcRoot     string
	DiskPath     string
	Hostname     string
}

func loadConfig() Config {
	ttlMs := envInt("PULSE_CACHE_TTL_MS", 2500)
	if ttlMs < 0 {
		ttlMs = 0
	}
	topN := envInt("PULSE_TOP_PROCESSES", 6)
	if topN < 1 {
		topN = 6
	}
	return Config{
		Bind:         envStr("PULSE_BIND", "0.0.0.0"),
		Port:         envStr("PULSE_PORT", "9191"),
		Token:        os.Getenv("PULSE_TOKEN"),
		CacheTTL:     time.Duration(ttlMs) * time.Millisecond,
		TopProcesses: topN,
		DockerSocket: envStr("DOCKER_SOCKET", "/var/run/docker.sock"),
		ProcRoot:     envStr("PULSE_PROC_ROOT", "/proc"),
		DiskPath:     envStr("PULSE_DISK_PATH", "/"),
		Hostname:     resolveHostname(),
	}
}

func resolveHostname() string {
	if h := strings.TrimSpace(os.Getenv("PULSE_HOSTNAME")); h != "" {
		return h
	}
	if path := strings.TrimSpace(os.Getenv("PULSE_HOSTNAME_FILE")); path != "" {
		if b, err := os.ReadFile(path); err == nil {
			if h := strings.TrimSpace(string(b)); h != "" {
				return h
			}
		}
	}
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "unknown"
}

func envStr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return v
}

func round1(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10) / 10
}
