package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	ListenAddr string
	WriterURL  string
	ReaderURLs []string
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

	return cfg, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
