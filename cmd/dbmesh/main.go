package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"dbmesh/internal/config"
	"dbmesh/internal/proxy"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		panic(err)
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	srv := proxy.NewServer(cfg, logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := srv.Run(ctx); err != nil && ctx.Err() == nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
