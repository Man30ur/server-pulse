package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type dockerContainer struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
}

// healthFromStatus extracts Docker's healthcheck state from the human status, e.g. "Up 3 hours (healthy)".
func healthFromStatus(status string) string {
	s := strings.ToLower(status)
	switch {
	case strings.Contains(s, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(s, "health: starting"):
		return "starting"
	case strings.Contains(s, "(healthy)"):
		return "healthy"
	}
	return ""
}

type dockerCPUStats struct {
	CPUUsage struct {
		TotalUsage  uint64   `json:"total_usage"`
		PercpuUsage []uint64 `json:"percpu_usage"`
	} `json:"cpu_usage"`
	SystemUsage uint64 `json:"system_cpu_usage"`
	OnlineCPUs  uint32 `json:"online_cpus"`
}

type dockerMemStats struct {
	Usage uint64            `json:"usage"`
	Limit uint64            `json:"limit"`
	Stats map[string]uint64 `json:"stats"`
}

type dockerStatsResp struct {
	CPUStats    dockerCPUStats `json:"cpu_stats"`
	PreCPUStats dockerCPUStats `json:"precpu_stats"`
	MemoryStats dockerMemStats `json:"memory_stats"`
}

type prevContainerCPU struct {
	totalUsage  uint64
	systemUsage uint64
}

// DockerCollector reads container states and stats strictly read-only over Unix socket.
type DockerCollector struct {
	socketPath string
	client     *http.Client
	workers    int
	mu         sync.Mutex
	prevCPU    map[string]prevContainerCPU

	dfMu      sync.Mutex
	dfCache   *DockerDiskMetric
	dfAt      time.Time
	dfLoading bool
}

func NewDockerCollector(socketPath string) *DockerCollector {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     30 * time.Second,
	}
	dc := &DockerCollector{
		socketPath: socketPath,
		client:     &http.Client{Transport: tr},
		workers:    6,
		prevCPU:    make(map[string]prevContainerCPU),
	}
	if socketPath != "" {
		dc.CollectDF() // warm /system/df asynchronously at startup
	}
	return dc
}

func (d *DockerCollector) Collect(ctx context.Context, hostMemBytes uint64) []ContainerMetric {
	if d.socketPath == "" {
		return []ContainerMetric{}
	}
	if _, err := os.Stat(d.socketPath); err != nil {
		return []ContainerMetric{}
	}
	var containers []dockerContainer
	if err := d.getJSONTimeout(ctx, "http://docker/containers/json?all=1", 2*time.Second, &containers); err != nil || len(containers) == 0 {
		return []ContainerMetric{}
	}

	results := make([]ContainerMetric, len(containers))
	type job struct {
		idx int
		id  string
	}
	jobs := make(chan job, len(containers))
	activeIDs := make(map[string]struct{}, len(containers))

	for i, c := range containers {
		shortID := c.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		name := shortID
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		state := strings.ToLower(c.State)
		results[i] = ContainerMetric{ID: shortID, Name: name, State: state, Status: c.Status, Health: healthFromStatus(c.Status)}
		if state == "running" {
			activeIDs[c.ID] = struct{}{}
			jobs <- job{idx: i, id: c.ID}
		}
	}
	close(jobs)

	workerCount := d.workers
	if len(activeIDs) < workerCount {
		workerCount = len(activeIDs)
	}
	var wg sync.WaitGroup
	for w := 0; w < workerCount; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				var st dockerStatsResp
				url := fmt.Sprintf("http://docker/containers/%s/stats?stream=false&one-shot=true", j.id)
				if err := d.getJSONTimeout(ctx, url, 2*time.Second, &st); err != nil {
					continue
				}
				results[j.idx].CPUPercent = round1(d.calcCPU(j.id, st))
				memMB, memPct := calcContainerMem(st.MemoryStats, hostMemBytes)
				results[j.idx].MemMB = round1(memMB)
				results[j.idx].MemPercent = round1(memPct)
			}
		}()
	}
	wg.Wait()
	d.prunePrev(activeIDs)

	sort.Slice(results, func(i, j int) bool {
		if results[i].MemMB != results[j].MemMB {
			return results[i].MemMB > results[j].MemMB
		}
		if (results[i].State == "running") != (results[j].State == "running") {
			return results[i].State == "running"
		}
		return results[i].Name < results[j].Name
	})
	return results
}

func (d *DockerCollector) getJSONTimeout(ctx context.Context, url string, timeout time.Duration, dst any) error {
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("docker status %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

func (d *DockerCollector) calcCPU(id string, st dockerStatsResp) float64 {
	curTotal := st.CPUStats.CPUUsage.TotalUsage
	curSys := st.CPUStats.SystemUsage
	var prevTotal, prevSys uint64
	if st.PreCPUStats.SystemUsage > 0 && curSys > st.PreCPUStats.SystemUsage {
		prevTotal, prevSys = st.PreCPUStats.CPUUsage.TotalUsage, st.PreCPUStats.SystemUsage
	} else {
		d.mu.Lock()
		if prev, ok := d.prevCPU[id]; ok {
			prevTotal, prevSys = prev.totalUsage, prev.systemUsage
		}
		d.prevCPU[id] = prevContainerCPU{totalUsage: curTotal, systemUsage: curSys}
		d.mu.Unlock()
	}
	if curTotal <= prevTotal || curSys <= prevSys {
		return 0
	}
	cpus := float64(st.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(len(st.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpus == 0 {
		cpus = 1
	}
	return (float64(curTotal-prevTotal) / float64(curSys-prevSys)) * cpus * 100.0
}

func (d *DockerCollector) prunePrev(active map[string]struct{}) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id := range d.prevCPU {
		if _, ok := active[id]; !ok {
			delete(d.prevCPU, id)
		}
	}
}

func calcContainerMem(m dockerMemStats, hostMemBytes uint64) (float64, float64) {
	used := m.Usage
	if v, ok := m.Stats["inactive_file"]; ok && v < used {
		used -= v
	} else if v, ok := m.Stats["total_inactive_file"]; ok && v < used {
		used -= v
	} else if v, ok := m.Stats["cache"]; ok && v < used {
		used -= v
	}
	limit := m.Limit
	if limit == 0 || (hostMemBytes > 0 && limit > hostMemBytes) {
		limit = hostMemBytes
	}
	memMB := float64(used) / (1024.0 * 1024.0)
	var memPct float64
	if limit > 0 {
		memPct = clampPct(float64(used) / float64(limit) * 100.0)
	}
	return memMB, memPct
}
