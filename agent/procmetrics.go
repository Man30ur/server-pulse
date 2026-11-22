package main

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func (s *SysCollector) snapshotProcTicks() map[int]uint64 {
	ticks := make(map[int]uint64)
	entries, err := os.ReadDir(s.procRoot)
	if err != nil {
		return ticks
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if _, procTicks, rss, ok := readProcStat(filepath.Join(s.procRoot, e.Name(), "stat")); ok && rss > 0 {
			ticks[pid] = procTicks
		}
	}
	return ticks
}

func (s *SysCollector) collectTopProcesses(totalDelta uint64) ([]ProcessMetric, []ProcessMetric) {
	entries, err := os.ReadDir(s.procRoot)
	if err != nil {
		return []ProcessMetric{}, []ProcessMetric{}
	}

	nextTicks := make(map[int]uint64, len(s.prevProcs))
	procs := make([]ProcessMetric, 0, 32)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		dir := filepath.Join(s.procRoot, e.Name())
		name, ticks, rssPages, ok := readProcStat(filepath.Join(dir, "stat"))
		if !ok || rssPages == 0 {
			continue
		}
		nextTicks[pid] = ticks
		if strings.HasPrefix(name, "containerd-shim") || isContainerProc(filepath.Join(dir, "cgroup")) {
			continue
		}
		var cpuPct float64
		if prev, exists := s.prevProcs[pid]; exists && totalDelta > 0 && ticks >= prev {
			cpuPct = round1(clampPct(float64(ticks-prev) / float64(totalDelta) * 100.0))
		}
		memMB := round1(float64(rssPages*s.pageSize) / (1024.0 * 1024.0))
		procs = append(procs, ProcessMetric{
			PID:        pid,
			Name:       name,
			CPUPercent: cpuPct,
			MemMB:      memMB,
		})
	}
	s.prevProcs = nextTicks

	byMem := make([]ProcessMetric, len(procs))
	copy(byMem, procs)
	sort.Slice(byMem, func(i, j int) bool {
		if byMem[i].MemMB != byMem[j].MemMB {
			return byMem[i].MemMB > byMem[j].MemMB
		}
		if byMem[i].CPUPercent != byMem[j].CPUPercent {
			return byMem[i].CPUPercent > byMem[j].CPUPercent
		}
		return byMem[i].PID < byMem[j].PID
	})
	if len(byMem) > s.topN {
		byMem = byMem[:s.topN]
	}

	sort.Slice(procs, func(i, j int) bool {
		if procs[i].CPUPercent != procs[j].CPUPercent {
			return procs[i].CPUPercent > procs[j].CPUPercent
		}
		if procs[i].MemMB != procs[j].MemMB {
			return procs[i].MemMB > procs[j].MemMB
		}
		return procs[i].PID < procs[j].PID
	})
	if len(procs) > s.topN {
		procs = procs[:s.topN]
	}
	return byMem, procs
}

func readProcStat(path string) (name string, ticks uint64, rss uint64, ok bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", 0, 0, false
	}
	raw := string(b)
	l := strings.IndexByte(raw, '(')
	r := strings.LastIndexByte(raw, ')')
	if l < 0 || r <= l || r+2 >= len(raw) {
		return "", 0, 0, false
	}
	name = raw[l+1 : r]
	fields := strings.Fields(raw[r+2:])
	if len(fields) < 22 {
		return "", 0, 0, false
	}
	utime, _ := strconv.ParseUint(fields[11], 10, 64)
	stime, _ := strconv.ParseUint(fields[12], 10, 64)
	rssVal, _ := strconv.ParseInt(fields[21], 10, 64)
	if rssVal < 0 {
		rssVal = 0
	}
	return name, utime + stime, uint64(rssVal), true
}

func isContainerProc(cgroupPath string) bool {
	b, err := os.ReadFile(cgroupPath)
	if err != nil {
		return false
	}
	s := string(b)
	return strings.Contains(s, "/docker/") ||
		strings.Contains(s, "/docker-") ||
		strings.Contains(s, "docker-") ||
		strings.Contains(s, "/kubepods") ||
		strings.Contains(s, "cri-containerd")
}
