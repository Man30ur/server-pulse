package main

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

type cpuSample struct {
	idle  uint64
	total uint64
	cores int
}

// SysCollector reads host metrics directly from Linux /proc and statfs.
type SysCollector struct {
	procRoot string
	diskPath string
	topN     int
	pageSize uint64

	mu         sync.Mutex
	prevCPU    cpuSample
	hasPrevCPU bool
	prevProcs  map[int]uint64
	prevIO     ioCounters
}

func NewSysCollector(procRoot, diskPath string, topN int) *SysCollector {
	s := &SysCollector{
		procRoot:  procRoot,
		diskPath:  diskPath,
		topN:      topN,
		pageSize:  uint64(os.Getpagesize()),
		prevProcs: make(map[int]uint64),
	}
	if cur, err := readCPUStat(filepath.Join(procRoot, "stat")); err == nil {
		s.prevCPU = cur
		s.hasPrevCPU = true
		s.prevProcs = s.snapshotProcTicks()
		s.collectExtras() // prime network/disk counters so the first request has rates
	}
	return s
}

func (s *SysCollector) Collect() HostSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	curCPU, err := readCPUStat(filepath.Join(s.procRoot, "stat"))
	cpuMetric := CPUMetric{Cores: runtime.NumCPU()}
	var totalDelta uint64
	if err == nil {
		if curCPU.cores > 0 {
			cpuMetric.Cores = curCPU.cores
		}
		if s.hasPrevCPU && curCPU.total > s.prevCPU.total {
			totalDelta = curCPU.total - s.prevCPU.total
			idleDelta := curCPU.idle - s.prevCPU.idle
			if totalDelta > 0 && idleDelta <= totalDelta {
				pct := (1.0 - float64(idleDelta)/float64(totalDelta)) * 100.0
				cpuMetric.Percent = round1(clampPct(pct))
			}
		}
		s.prevCPU = curCPU
		s.hasPrevCPU = true
	}

	memMetric, totalBytes := readMemInfo(filepath.Join(s.procRoot, "meminfo"))
	load, netM, ioM := s.collectExtras()

	return HostSnapshot{
		UptimeSec:     readUptime(filepath.Join(s.procRoot, "uptime")),
		CPU:           cpuMetric,
		Memory:        memMetric,
		MemTotalBytes: totalBytes,
		Disk:          readDiskUsage(s.diskPath),
		Load:          load,
		Network:       netM,
		DiskIO:        ioM,
		Processes:     s.collectTopProcesses(totalDelta),
	}
}

func readCPUStat(path string) (cpuSample, error) {
	f, err := os.Open(path)
	if err != nil {
		return cpuSample{}, err
	}
	defer f.Close()

	var sample cpuSample
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "cpu ") {
			for i, raw := range strings.Fields(line)[1:] {
				v, _ := strconv.ParseUint(raw, 10, 64)
				sample.total += v
				if i == 3 || i == 4 { // idle + iowait
					sample.idle += v
				}
			}
		} else if len(line) > 3 && strings.HasPrefix(line, "cpu") && line[3] >= '0' && line[3] <= '9' {
			sample.cores++
		} else if sample.total > 0 {
			break
		}
	}
	return sample, sc.Err()
}

func readMemInfo(path string) (MemoryMetric, uint64) {
	f, err := os.Open(path)
	if err != nil {
		return MemoryMetric{}, 0
	}
	defer f.Close()

	vals := make(map[string]uint64, 8)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		switch key {
		case "MemTotal", "MemAvailable", "MemFree", "Buffers", "Cached", "SwapTotal", "SwapFree":
			if v, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				vals[key] = v
			}
		}
	}

	totalKB := vals["MemTotal"]
	availKB, hasAvail := vals["MemAvailable"]
	if !hasAvail {
		availKB = vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	}
	var usedKB uint64
	if totalKB > availKB {
		usedKB = totalKB - availKB
	}
	var memPct float64
	if totalKB > 0 {
		memPct = round1(clampPct(float64(usedKB) / float64(totalKB) * 100.0))
	}

	swapTotalKB := vals["SwapTotal"]
	var swapUsedKB uint64
	if swapTotalKB > vals["SwapFree"] {
		swapUsedKB = swapTotalKB - vals["SwapFree"]
	}

	return MemoryMetric{
		UsedMB:      int64(usedKB / 1024),
		TotalMB:     int64(totalKB / 1024),
		Percent:     memPct,
		SwapUsedMB:  int64(swapUsedKB / 1024),
		SwapTotalMB: int64(swapTotalKB / 1024),
	}, totalKB * 1024
}

func readUptime(path string) int64 {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	sec, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || sec < 0 {
		return 0
	}
	return int64(sec)
}

func readDiskUsage(path string) DiskMetric {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil || st.Blocks == 0 {
		return DiskMetric{}
	}
	bsize := uint64(st.Bsize)
	total := st.Blocks * bsize
	free := st.Bfree * bsize
	var used uint64
	if total > free {
		used = total - free
	}
	const gb = 1024.0 * 1024.0 * 1024.0
	return DiskMetric{
		UsedGB:  round1(float64(used) / gb),
		TotalGB: round1(float64(total) / gb),
		Percent: round1(clampPct(float64(used) / float64(total) * 100.0)),
	}
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
