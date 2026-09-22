package proxy

import (
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nsarfati/dbmesh/internal/config"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func metricCount(t *testing.T, m *queryMetrics, labels map[string]string) float64 {
	t.Helper()
	families, err := m.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var total float64
	for _, family := range families {
		if family.GetName() != "dbmesh_queries_total" {
			continue
		}
		for _, metric := range family.Metric {
			matches := 0
			for _, label := range metric.Label {
				if value, ok := labels[label.GetName()]; ok && value == label.GetValue() {
					matches++
				}
			}
			if matches == len(labels) {
				total += metric.GetCounter().GetValue()
			}
		}
	}
	return total
}

func TestQueryMetrics(t *testing.T) {
	cfg := config.Config{Databases: map[string]config.Database{"demo": {ReaderURLs: []string{"reader"}}}}
	m := newQueryMetrics(cfg)
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); m.observe("demo", "select", "replica", 1, time.Millisecond, nil, nil) }()
	}
	wg.Wait()
	m.observe("demo", "multi", "primary", 0, time.Millisecond, []*pgconn.Result{{Err: &pgconn.PgError{Code: "22012"}}}, nil)
	m.observe("demo", "update", "primary", 0, time.Millisecond, nil, &pgconn.PgError{Code: "42501"})
	m.observe("demo", "insert", "primary", 0, time.Millisecond, nil, errors.New("connection lost"))
	for _, tt := range []struct {
		labels map[string]string
		want   float64
	}{
		{map[string]string{}, 53},
		{map[string]string{"target": "replica", "reader": "1", "outcome": "success"}, 50},
		{map[string]string{"operation": "multi", "outcome": "error"}, 1},
		{map[string]string{"operation": "update", "outcome": "error"}, 1},
		{map[string]string{"outcome": "unknown"}, 1},
	} {
		if got := metricCount(t, m, tt.labels); got != tt.want {
			t.Fatalf("%v: got %v want %v", tt.labels, got, tt.want)
		}
	}
	response := httptest.NewRecorder()
	promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{}).ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `dbmesh_query_duration_seconds_count{database="demo",reader="1",target="replica"} 50`) {
		t.Fatalf("bad metrics response: %s", response.Body.String())
	}
	// Per-server registries do not share counters or collide on registration.
	if got := metricCount(t, newQueryMetrics(cfg), nil); got != 0 {
		t.Fatalf("new registry has %v requests", got)
	}
}
