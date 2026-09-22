package proxy

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nsarfati/dbmesh/internal/config"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type queryMetrics struct {
	registry *prometheus.Registry
	queries  *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

func newQueryMetrics(cfg config.Config) *queryMetrics {
	m := &queryMetrics{
		registry: prometheus.NewRegistry(),
		queries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "dbmesh_queries_total",
			Help: "Completed client Simple Query message attempts sent upstream, not individual statements or committed transactions.",
		}, []string{"database", "operation", "target", "reader", "outcome"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "dbmesh_query_duration_seconds",
			Help:    "Time executing a client Simple Query message upstream, including reading results; excludes routing, audit setup and client delivery.",
			Buckets: []float64{.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30},
		}, []string{"database", "target", "reader"}),
	}
	m.registry.MustRegister(m.queries, m.duration)
	// Expose zeros before the first request so rate/increase has a baseline.
	// Labels are bounded by configured databases/readers and these enums.
	for db, c := range cfg.Databases {
		for reader := 0; reader <= len(c.ReaderURLs); reader++ {
			target := "primary"
			if reader > 0 {
				target = "replica"
			}
			id := strconv.Itoa(reader)
			m.duration.WithLabelValues(db, target, id)
			for _, op := range []string{"select", "insert", "update", "delete", "merge", "transaction", "other", "multi", "unknown", "empty"} {
				for _, outcome := range []string{"success", "error", "unknown"} {
					m.queries.WithLabelValues(db, op, target, id, outcome)
				}
			}
		}
	}
	return m
}

func (m *queryMetrics) observe(db, operation, target string, reader int, elapsed time.Duration, results []*pgconn.Result, err error) {
	outcome := "success"
	if err == nil {
		for _, result := range results {
			if result.Err != nil {
				err = result.Err
				break
			}
		}
	}
	// A transport failure means the final result is unknown, even if earlier
	// commands returned results. SQL errors are confirmed execution failures.
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			outcome = "error"
		} else {
			outcome = "unknown"
		}
	}
	id := strconv.Itoa(reader)
	m.queries.WithLabelValues(db, operation, target, id, outcome).Inc()
	m.duration.WithLabelValues(db, target, id).Observe(elapsed.Seconds())
}

func (s *Server) startMetrics() (func(), error) {
	if s.cfg.MetricsListen == "" {
		return func() {}, nil
	}
	ln, err := net.Listen("tcp", s.cfg.MetricsListen)
	if err != nil {
		return nil, fmt.Errorf("metrics listener: %w", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.metrics.registry, promhttp.HandlerOpts{}))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.logger.Error("metrics listener stopped", "err", err)
		}
	}()
	s.logger.Info("metrics listening", "addr", ln.Addr().String(), "path", "/metrics")
	return func() { _ = server.Close(); <-done }, nil
}
