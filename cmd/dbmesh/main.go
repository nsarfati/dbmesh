package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/nsarfati/dbmesh/internal/config"
	"github.com/nsarfati/dbmesh/internal/proxy"
)

func main() {
	path := flag.String("config", envOr("DBMESH_CONFIG", "config_proxy.yaml"), "path to the YAML configuration file")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel()}))
	cfg, err := config.Load(*path)
	if err != nil {
		logger.Error("invalid configuration", "err", err)
		os.Exit(1)
	}
	srv := proxy.NewServer(cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := srv.Run(ctx); err != nil && ctx.Err() == nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// logLevel reads DBMESH_LOG_LEVEL ("debug", "info", "warn" or "error"; case-insensitive). Defaults to error.
func logLevel() slog.Level {
	var level slog.Level
	if err := level.UnmarshalText([]byte(envOr("DBMESH_LOG_LEVEL", "error"))); err != nil {
		return slog.LevelError
	}
	return level
}
