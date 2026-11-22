package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ioCounters holds cumulative host counters used for rate calculations.
type ioCounters struct {
	at       time.Time
	netRx    uint64
	netTx    uint64
	diskRead uint64
	diskWrit uint64
	ok       bool
}

// collectExtras returns load average plus network and disk throughput rates.
// Must be called with s.mu held.
func (s *SysCollector) collectExtras() ([3]float64, NetMetric, DiskIOMetric) {
	load := readLoadAvg(filepath.Join(s.procRoot, "loadavg"))

	cur := ioCounters{at: time.Now(), ok: true}
	netPath := filepath.Join(s.procRoot, "1", "net", "dev") // host netns via host PID 1
	if _, err := os.Stat(netPath); err != nil {
		netPath = filepath.Join(s.procRoot, "net", "dev")
	}
	cur.netRx, cur.netTx = readNetDev(netPath)
	cur.diskRead, cur.diskWrit = readDiskStats(filepath.Join(s.procRoot, "diskstats"))

	var netM NetMetric
	var ioM DiskIOMetric
	if prev := s.prevIO; prev.ok {
		if secs := cur.at.Sub(prev.at).Seconds(); secs > 0.2 {
			netM.RxBps = rate(prev.netRx, cur.netRx, secs)
			netM.TxBps = rate(prev.netTx, cur.netTx, secs)
			ioM.ReadBps = rate(prev.diskRead, cur.diskRead, secs)
			ioM.WriteBps = rate(prev.diskWrit, cur.diskWrit, secs)
		}
	}
	s.prevIO = cur
	return load, netM, ioM
}

func rate(prev, cur uint64, secs float64) float64 {
	if cur < prev {
		return 0 // counter reset
	}
	return float64(int64(float64(cur-prev) / secs))
}

func readLoadAvg(path string) [3]float64 {
	var out [3]float64
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	f := strings.Fields(string(b))
	for i := 0; i < 3 && i < len(f); i++ {
		v, _ := strconv.ParseFloat(f[i], 64)
		out[i] = float64(int64(v*100)) / 100
	}
	return out
}

// isVirtualIface skips loopback and Docker/bridge/veth interfaces so totals reflect real traffic.
func isVirtualIface(name string) bool {
	for _, p := range []string{"lo", "docker", "br-", "veth", "virbr", "cni", "flannel", "tun", "wg"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func readNetDev(path string) (rx, tx uint64) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		if isVirtualIface(strings.TrimSpace(line[:colon])) {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

// isWholeDisk matches physical/virtual disks (not partitions, loop or ram devices).
func isWholeDisk(name string) bool {
	switch {
	case strings.HasPrefix(name, "nvme"):
		return strings.Contains(name, "n") && !strings.Contains(name, "p")
	case strings.HasPrefix(name, "sd"), strings.HasPrefix(name, "vd"), strings.HasPrefix(name, "xvd"), strings.HasPrefix(name, "hd"):
		last := name[len(name)-1]
		return last < '0' || last > '9'
	case strings.HasPrefix(name, "mmcblk"):
		return !strings.Contains(name, "p")
	}
	return false
}

func readDiskStats(path string) (readBytes, writeBytes uint64) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 10 || !isWholeDisk(fields[2]) {
			continue
		}
		rs, _ := strconv.ParseUint(fields[5], 10, 64) // sectors read
		ws, _ := strconv.ParseUint(fields[9], 10, 64) // sectors written
		readBytes += rs * 512
		writeBytes += ws * 512
	}
	return readBytes, writeBytes
}
