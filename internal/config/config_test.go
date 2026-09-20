package config

import (
	"testing"
	"time"
)

func TestReaderPolicyFromEnv(t *testing.T) {
	t.Setenv("DBMESH_WRITER_URL", "postgres://localhost/demo")
	for _, name := range []string{"DBMESH_READER_CHECK_INTERVAL", "DBMESH_READER_CHECK_TIMEOUT", "DBMESH_READER_MAX_LAG_BYTES", "DBMESH_READER_STATUS_MAX_AGE"} {
		t.Setenv(name, "")
	}
	cfg, err := FromEnv()
	if err != nil || cfg.ReaderPolicy != DefaultReaderPolicy() {
		t.Fatalf("defaults: %+v %v", cfg, err)
	}
	t.Setenv("DBMESH_READER_STATUS_MAX_AGE", "9s")
	t.Setenv("DBMESH_READER_CHECK_INTERVAL", "2s")
	t.Setenv("DBMESH_READER_CHECK_TIMEOUT", "250ms")
	t.Setenv("DBMESH_READER_MAX_LAG_BYTES", "0")
	cfg, err = FromEnv()
	if err != nil || cfg.ReaderPolicy.StatusMaxAge != 9*time.Second || cfg.ReaderPolicy.MaxLagBytes != 0 ||
		cfg.ReaderPolicy.CheckInterval != 2*time.Second || cfg.ReaderPolicy.CheckTimeout != 250*time.Millisecond {
		t.Fatalf("overrides: %+v %v", cfg, err)
	}
	for _, tt := range []struct{ name, value string }{
		{"DBMESH_READER_STATUS_MAX_AGE", "0s"},
		{"DBMESH_READER_STATUS_MAX_AGE", "-1s"},
		{"DBMESH_READER_CHECK_INTERVAL", "bad"},
		{"DBMESH_READER_CHECK_TIMEOUT", "0"},
		{"DBMESH_READER_MAX_LAG_BYTES", "-1"},
		{"DBMESH_READER_MAX_LAG_BYTES", "1MiB"},
		{"DBMESH_READER_MAX_LAG_BYTES", "999999999999999999999999"},
	} {
		t.Run(tt.name+tt.value, func(t *testing.T) {
			t.Setenv(tt.name, tt.value)
			if _, err := FromEnv(); err == nil {
				t.Fatal("accepted invalid policy")
			}
		})
	}
}
