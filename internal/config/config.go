package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr   string
	WriterURL    string
	ReaderURLs   []string
	ReaderPolicy ReaderPolicy
}

// ReaderPolicy bounds the age and WAL distance of monitoring samples.
type ReaderPolicy struct {
	CheckInterval time.Duration
	CheckTimeout  time.Duration
	MaxLagBytes   int64
	StatusMaxAge  time.Duration
}

func DefaultReaderPolicy() ReaderPolicy {
	return ReaderPolicy{
		CheckInterval: time.Second,
		CheckTimeout:  500 * time.Millisecond,
		MaxLagBytes:   1024 * 1024,
		StatusMaxAge:  3 * time.Second,
	}
}

func FromEnv() (Config, error) {
	cfg := Config{
		ListenAddr: envOr("DBMESH_LISTEN", ":6432"),
		WriterURL:  os.Getenv("DBMESH_WRITER_URL"),
	}

	if cfg.WriterURL == "" {
		return Config{}, fmt.Errorf("DBMESH_WRITER_URL is required")
	}

	rawReaders := os.Getenv("DBMESH_READER_URLS")
	for _, item := range strings.Split(rawReaders, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			cfg.ReaderURLs = append(cfg.ReaderURLs, item)
		}
	}

	cfg.ReaderPolicy = DefaultReaderPolicy()
	for _, setting := range []struct {
		name  string
		value *time.Duration
	}{
		{"DBMESH_READER_CHECK_INTERVAL", &cfg.ReaderPolicy.CheckInterval},
		{"DBMESH_READER_CHECK_TIMEOUT", &cfg.ReaderPolicy.CheckTimeout},
		{"DBMESH_READER_STATUS_MAX_AGE", &cfg.ReaderPolicy.StatusMaxAge},
	} {
		raw := envOr(setting.name, setting.value.String())
		value, err := time.ParseDuration(raw)
		if err != nil || value <= 0 {
			return Config{}, fmt.Errorf("%s must be a positive duration", setting.name)
		}
		*setting.value = value
	}
	rawLag := envOr("DBMESH_READER_MAX_LAG_BYTES", strconv.FormatInt(cfg.ReaderPolicy.MaxLagBytes, 10))
	lag, err := strconv.ParseInt(rawLag, 10, 64)
	if err != nil || lag < 0 {
		return Config{}, fmt.Errorf("DBMESH_READER_MAX_LAG_BYTES must be a non-negative integer")
	}
	cfg.ReaderPolicy.MaxLagBytes = lag
	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
