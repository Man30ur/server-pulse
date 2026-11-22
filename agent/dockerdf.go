package main

import (
	"context"
	"os"
	"time"
)

const dockerDFTTL = 60 * time.Second

type dockerDFResp struct {
	LayersSize int64 `json:"LayersSize"`
	Images     []struct {
		Size       int64 `json:"Size"`
		SharedSize int64 `json:"SharedSize"`
		Containers int64 `json:"Containers"`
	} `json:"Images"`
	Containers []struct {
		State  string `json:"State"`
		SizeRw int64  `json:"SizeRw"`
	} `json:"Containers"`
	Volumes []struct {
		UsageData *struct {
			Size     int64 `json:"Size"`
			RefCount int64 `json:"RefCount"`
		} `json:"UsageData"`
	} `json:"Volumes"`
	BuildCache []struct {
		Size  int64 `json:"Size"`
		InUse bool  `json:"InUse"`
	} `json:"BuildCache"`
}

// CollectDF returns a cached Docker disk summary without blocking /api/metrics.
// Refreshes asynchronously in the background at most once per dockerDFTTL.
func (d *DockerCollector) CollectDF() *DockerDiskMetric {
	if d.socketPath == "" {
		return nil
	}
	d.dfMu.Lock()
	snap := d.dfCache
	stale := snap == nil || time.Since(d.dfAt) >= dockerDFTTL
	shouldFetch := stale && !d.dfLoading
	if shouldFetch {
		d.dfLoading = true
	}
	d.dfMu.Unlock()

	if shouldFetch {
		go d.refreshDF()
	}
	if snap == nil {
		return nil
	}
	cp := *snap
	return &cp
}

func (d *DockerCollector) refreshDF() {
	defer func() {
		d.dfMu.Lock()
		d.dfLoading = false
		d.dfMu.Unlock()
	}()

	if _, err := os.Stat(d.socketPath); err != nil {
		return
	}
	var raw dockerDFResp
	if err := d.getJSONTimeout(context.Background(), "http://docker/system/df", 12*time.Second, &raw); err != nil {
		return
	}
	parsed := parseDockerDF(raw)

	d.dfMu.Lock()
	d.dfCache = &parsed
	d.dfAt = time.Now()
	d.dfMu.Unlock()
}

func parseDockerDF(raw dockerDFResp) DockerDiskMetric {
	var imgBytes, imgReclaim int64
	if raw.LayersSize > 0 {
		imgBytes = raw.LayersSize
	}
	for _, img := range raw.Images {
		if raw.LayersSize <= 0 && img.Size > 0 {
			imgBytes += img.Size
		}
		if img.Containers == 0 && img.Size > 0 {
			unique := img.Size
			if img.SharedSize > 0 && img.SharedSize < img.Size {
				unique = img.Size - img.SharedSize
			}
			imgReclaim += unique
		}
	}
	if imgReclaim > imgBytes {
		imgReclaim = imgBytes
	}

	var ctrBytes, ctrReclaim int64
	for _, c := range raw.Containers {
		if c.SizeRw > 0 {
			ctrBytes += c.SizeRw
			if c.State != "running" {
				ctrReclaim += c.SizeRw
			}
		}
	}

	var volBytes, volReclaim int64
	for _, v := range raw.Volumes {
		if v.UsageData != nil && v.UsageData.Size > 0 {
			volBytes += v.UsageData.Size
			if v.UsageData.RefCount == 0 {
				volReclaim += v.UsageData.Size
			}
		}
	}

	var bcBytes, bcReclaim int64
	for _, bc := range raw.BuildCache {
		if bc.Size > 0 {
			bcBytes += bc.Size
			if !bc.InUse {
				bcReclaim += bc.Size
			}
		}
	}

	const gb = 1024.0 * 1024.0 * 1024.0
	total := imgBytes + ctrBytes + volBytes + bcBytes
	reclaim := imgReclaim + ctrReclaim + volReclaim + bcReclaim
	return DockerDiskMetric{
		ImagesGB:        round1(float64(imgBytes) / gb),
		ImagesCount:     len(raw.Images),
		ContainersGB:    round1(float64(ctrBytes) / gb),
		ContainersCount: len(raw.Containers),
		VolumesGB:       round1(float64(volBytes) / gb),
		VolumesCount:    len(raw.Volumes),
		BuildCacheGB:    round1(float64(bcBytes) / gb),
		BuildCacheCount: len(raw.BuildCache),
		TotalGB:         round1(float64(total) / gb),
		ReclaimableGB:   round1(float64(reclaim) / gb),
	}
}
