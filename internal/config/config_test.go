package config

import (
	"strings"
	"testing"
	"time"
)

const minimal = `
databases:
  demo:
    writer: {user: app, pwd: secret, host: "db:5432"}
`

func TestParseMultipleDatabases(t *testing.T) {
	cfg, err := Parse([]byte(`
listen: ":7000"
metrics_listen: "127.0.0.1:9091"
databases:
  db1:
    writer: {user: w, pwd: "p@ss/word:1", host: "w1:5432", sslmode: disable}
    reader:
      user: r
      pwd: rp
      host: ["r1:5432", "r2:5433"]
      check_interval: 2s
      check_timeout: 250ms
      max_lag_bytes: 0
      status_max_age: 9s
  db2:
    writer: {user: w2, host: "w2"}
`))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":7000" || cfg.MetricsListen != "127.0.0.1:9091" || len(cfg.Databases) != 2 {
		t.Fatalf("%+v", cfg)
	}
	db1 := cfg.Databases["db1"]
	if db1.WriterURL != "postgres://w:p%40ss%2Fword%3A1@w1:5432/db1?sslmode=disable" {
		t.Fatalf("writer url %q", db1.WriterURL)
	}
	if len(db1.ReaderURLs) != 2 || db1.ReaderURLs[1] != "postgres://r:rp@r2:5433/db1" {
		t.Fatalf("reader urls %v", db1.ReaderURLs)
	}
	want := ReaderPolicy{CheckInterval: 2 * time.Second, CheckTimeout: 250 * time.Millisecond, MaxLagBytes: 0, StatusMaxAge: 9 * time.Second}
	if db1.ReaderPolicy != want {
		t.Fatalf("policy %+v", db1.ReaderPolicy)
	}
	db2 := cfg.Databases["db2"]
	if db2.WriterURL != "postgres://w2@w2/db2" || len(db2.ReaderURLs) != 0 || db2.ReaderPolicy != DefaultReaderPolicy() {
		t.Fatalf("db2 %+v", db2)
	}
}

func TestParseDefaults(t *testing.T) {
	cfg, err := Parse([]byte(minimal))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != ":6432" || cfg.MetricsListen != "" || len(cfg.Audit.Sinks) != 0 {
		t.Fatalf("%+v", cfg)
	}
	if cfg.Audit.Retention != 7*24*time.Hour || cfg.Audit.CleanupInterval != time.Minute || cfg.Audit.CleanupBatch != 1000 {
		t.Fatalf("audit defaults %+v", cfg.Audit)
	}
}

func TestReaderPolicyDefaultsPerDatabase(t *testing.T) {
	cfg, err := Parse([]byte(`
databases:
  a:
    writer: {user: u, host: h}
    reader: {user: u, host: [r], status_max_age: 9s}
  b:
    writer: {user: u, host: h}
    reader: {user: u, host: [r]}
`))
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultReaderPolicy()
	want.StatusMaxAge = 9 * time.Second
	if cfg.Databases["a"].ReaderPolicy != want || cfg.Databases["b"].ReaderPolicy != DefaultReaderPolicy() {
		t.Fatalf("%+v", cfg.Databases)
	}
}

func TestAuditConfig(t *testing.T) {
	cfg, err := Parse([]byte(minimal + `
audit:
  sinks: [postgres]
  postgres: {url: "postgres://localhost/audit"}
  retention: 0
  cleanup_interval: 30s
  cleanup_batch: 50
`))
	if err != nil {
		t.Fatal(err)
	}
	a := cfg.Audit
	if len(a.Sinks) != 1 || a.DatabaseURL != "postgres://localhost/audit" || a.Retention != 0 ||
		a.CleanupInterval != 30*time.Second || a.CleanupBatch != 50 {
		t.Fatalf("%+v", a)
	}
}

func TestParseRejectsInvalid(t *testing.T) {
	for name, tt := range map[string]struct{ yaml, want string }{
		"no databases":      {"listen: ':1'", "at least one database"},
		"missing writer":    {"databases:\n  d:\n    reader: {user: u, host: [r]}", "writer"},
		"reader no user":    {"databases:\n  d:\n    writer: {user: u, host: h}\n    reader: {host: [r]}", "reader: user"},
		"empty reader host": {"databases:\n  d:\n    writer: {user: u, host: h}\n    reader: {user: u, host: ['']}", "empty host"},
		"unknown key":       {minimal + "listenn: x\n", "listenn"},
		"unknown nested":    {"databases:\n  d:\n    writer: {user: u, host: h, password: x}", "password"},
		"bad interval":      {"databases:\n  d:\n    writer: {user: u, host: h}\n    reader: {user: u, host: [r], check_interval: bad}", "not a valid duration"},
		"negative timeout":  {"databases:\n  d:\n    writer: {user: u, host: h}\n    reader: {user: u, host: [r], check_timeout: -1s}", "check_timeout"},
		"negative lag":      {"databases:\n  d:\n    writer: {user: u, host: h}\n    reader: {user: u, host: [r], max_lag_bytes: -1}", "max_lag_bytes"},
		"unknown sink":      {minimal + "audit: {sinks: [queue]}", "unsupported audit sink"},
		"duplicate sink":    {minimal + "audit: {sinks: [postgres, postgres], postgres: {url: x}}", "duplicate audit sink"},
		"missing audit url": {minimal + "audit: {sinks: [postgres]}", "audit.postgres.url"},
		"negative retain":   {minimal + "audit: {retention: -1h}", "retention"},
		"negative batch":    {minimal + "audit: {cleanup_batch: -1}", "cleanup_batch"},
		"negative cleanup":  {minimal + "audit: {cleanup_interval: -1s}", "cleanup_interval"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Parse([]byte(tt.yaml))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err=%v; want it to mention %q", err, tt.want)
			}
		})
	}
}
