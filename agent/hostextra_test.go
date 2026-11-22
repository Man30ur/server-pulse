package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHostExtrasParsersAndRates(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, s string) {
		p := filepath.Join(dir, rel)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	netDev := func(rx, tx int) string {
		return "Inter-|\n face |\n" +
			"    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n" +
			"  eth0: " + itoa(rx) + " 0 0 0 0 0 0 0 " + itoa(tx) + " 0 0 0 0 0 0 0\n" +
			"docker0: 5000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\n" +
			"vethab: 7000 0 0 0 0 0 0 0 7000 0 0 0 0 0 0 0\n"
	}
	disk := func(rs, ws int) string {
		return " 253 0 vda 1 0 " + itoa(rs) + " 0 1 0 " + itoa(ws) + " 0 0 0 0\n" +
			" 253 1 vda1 1 0 99999 0 1 0 99999 0 0 0 0\n" +
			"   7 0 loop0 1 0 88888 0 1 0 88888 0 0 0 0\n"
	}
	write("loadavg", "1.25 0.80 0.50 3/400 99\n")
	write("1/net/dev", netDev(1000, 2000))
	write("diskstats", disk(100, 200))

	if got := readLoadAvg(filepath.Join(dir, "loadavg")); got != [3]float64{1.25, 0.8, 0.5} {
		t.Fatalf("loadavg = %v", got)
	}
	if rx, tx := readNetDev(filepath.Join(dir, "1/net/dev")); rx != 1000 || tx != 2000 {
		t.Fatalf("net rx=%d tx=%d (virtual ifaces must be excluded)", rx, tx)
	}
	if r, w := readDiskStats(filepath.Join(dir, "diskstats")); r != 100*512 || w != 200*512 {
		t.Fatalf("disk r=%d w=%d (partitions/loop must be excluded)", r, w)
	}

	s := &SysCollector{procRoot: dir}
	s.collectExtras()
	s.prevIO.at = s.prevIO.at.Add(-2 * time.Second) // simulate 2s between samples
	write("1/net/dev", netDev(3000, 6000))
	write("diskstats", disk(300, 600))
	load, netM, ioM := s.collectExtras()
	if load[0] != 1.25 {
		t.Fatalf("load = %v", load)
	}
	if netM.RxBps < 950 || netM.RxBps > 1050 || netM.TxBps < 1900 || netM.TxBps > 2100 {
		t.Fatalf("net rates = %+v", netM)
	}
	if ioM.ReadBps < 48000 || ioM.ReadBps > 54000 || ioM.WriteBps < 97000 || ioM.WriteBps > 108000 {
		t.Fatalf("disk io rates = %+v", ioM)
	}
}

func TestWholeDiskAndHealthDetection(t *testing.T) {
	for name, want := range map[string]bool{
		"sda": true, "sda1": false, "vda": true, "vda2": false, "nvme0n1": true,
		"nvme0n1p1": false, "mmcblk0": true, "mmcblk0p1": false, "loop0": false, "dm-0": false,
	} {
		if got := isWholeDisk(name); got != want {
			t.Errorf("isWholeDisk(%q) = %v, want %v", name, got, want)
		}
	}
	for status, want := range map[string]string{
		"Up 3 hours (healthy)":            "healthy",
		"Up 5 seconds (health: starting)": "starting",
		"Up 2 days (unhealthy)":           "unhealthy",
		"Up 4 minutes":                    "",
		"Exited (0) 2 hours ago":          "",
	} {
		if got := healthFromStatus(status); got != want {
			t.Errorf("healthFromStatus(%q) = %q, want %q", status, got, want)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

func TestParseDockerDF(t *testing.T) {
	const gb = 1024 * 1024 * 1024
	var raw dockerDFResp
	raw.LayersSize = 10 * gb
	raw.Images = []struct {
		Size       int64 `json:"Size"`
		SharedSize int64 `json:"SharedSize"`
		Containers int64 `json:"Containers"`
	}{
		{Size: 4 * gb, SharedSize: gb, Containers: 1},
		{Size: 3 * gb, SharedSize: gb, Containers: 0}, // 2 GB reclaimable
	}
	raw.Containers = []struct {
		State  string `json:"State"`
		SizeRw int64  `json:"SizeRw"`
	}{
		{State: "running", SizeRw: gb / 2},
		{State: "exited", SizeRw: gb / 2},
	}
	raw.Volumes = []struct {
		UsageData *struct {
			Size     int64 `json:"Size"`
			RefCount int64 `json:"RefCount"`
		} `json:"UsageData"`
	}{
		{UsageData: &struct {
			Size     int64 `json:"Size"`
			RefCount int64 `json:"RefCount"`
		}{Size: 4 * gb, RefCount: 1}},
		{UsageData: &struct {
			Size     int64 `json:"Size"`
			RefCount int64 `json:"RefCount"`
		}{Size: 2 * gb, RefCount: 0}},
	}
	raw.BuildCache = []struct {
		Size  int64 `json:"Size"`
		InUse bool  `json:"InUse"`
	}{
		{Size: 1 * gb, InUse: false},
	}

	got := parseDockerDF(raw)
	if got.ImagesGB != 10.0 || got.ImagesCount != 2 {
		t.Fatalf("unexpected images: %+v", got)
	}
	if got.ContainersGB != 1.0 || got.VolumesGB != 6.0 || got.BuildCacheGB != 1.0 {
		t.Fatalf("unexpected breakdown: %+v", got)
	}
	if got.TotalGB != 18.0 || got.ReclaimableGB != 5.5 {
		t.Fatalf("expected total=18.0 reclaim=5.5, got %+v", got)
	}
}
