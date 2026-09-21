package upstream

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nsarfati/dbmesh/internal/config"
)

func TestReaderEligibility(t *testing.T) {
	now := time.Now()
	policy := config.DefaultReaderPolicy()
	for _, tt := range []struct {
		name   string
		status ReaderStatus
		want   bool
	}{
		{"unknown", ReaderStatus{}, false},
		{"failed", ReaderStatus{Reason: "reader check failed"}, false},
		{"no timestamp", ReaderStatus{Valid: true}, false},
		{"fresh", ReaderStatus{Valid: true, SampledAt: now}, true},
		{"lag boundary", ReaderStatus{Valid: true, SampledAt: now, LagBytes: 1048576}, true},
		{"too far behind", ReaderStatus{Valid: true, SampledAt: now, LagBytes: 1048577}, false},
		{"age boundary", ReaderStatus{Valid: true, SampledAt: now.Add(-3 * time.Second)}, true},
		{"expired", ReaderStatus{Valid: true, SampledAt: now.Add(-3*time.Second - time.Nanosecond)}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ok, reason := tt.status.Eligible(now, policy)
			if ok != tt.want || (!ok && reason == "") {
				t.Fatalf("eligible=%v reason=%q", ok, reason)
			}
		})
	}
	policy.StatusMaxAge = 10 * time.Second
	if ok, _ := (ReaderStatus{Valid: true, SampledAt: now.Add(-5 * time.Second)}).Eligible(now, policy); !ok {
		t.Fatal("ignored configurable max age")
	}
}

func TestParseLSN(t *testing.T) {
	for raw, want := range map[string]uint64{"0/0": 0, "1/0": 1 << 32, "AB/1234": 0xAB00001234, "FFFFFFFF/FFFFFFFF": ^uint64(0)} {
		got, err := parseLSN(raw)
		if err != nil || got != want {
			t.Fatalf("%s: %x %v", raw, got, err)
		}
	}
	for _, raw := range []string{"", "1", "G/0", "0/100000000", "100000000/0", "1/2/3"} {
		if _, err := parseLSN(raw); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}

func TestReaderFallbackIntegration(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// Port zero is not a running PostgreSQL endpoint. The second reader is real.
	urls := []string{"postgres://dbmesh:dbmesh@127.0.0.1:0/demo?sslmode=disable", strings.Split(readers, ",")[0]}
	policy := config.DefaultReaderPolicy()
	m := NewMonitor(writer, urls, policy, nil)
	defer m.Close()
	m.Refresh(ctx)
	s, err := Connect(ctx, writer, urls, "demo", m)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(ctx)
	conn, id, reason := s.Reader(ctx)
	if id != 2 || conn == s.Writer() {
		t.Fatalf("reader=%d reason=%s", id, reason)
	}
	// Force an expired sample; selection must use primary without querying a reader.
	m.publish(1, ReaderStatus{Valid: true, SampledAt: time.Now().Add(-policy.StatusMaxAge - time.Second)})
	conn, id, reason = s.Reader(ctx)
	if id != 0 || conn != s.Writer() || !strings.Contains(reason, "stale") {
		t.Fatalf("reader=%d reason=%s", id, reason)
	}
	m.Refresh(ctx)
	// An outage invalidates old session sockets even if locally still open.
	old := s.readers[1]
	m.publish(1, ReaderStatus{Reason: "reader check failed"})
	m.Refresh(ctx)
	conn, id, reason = s.Reader(ctx)
	if id != 2 || conn == old || conn.IsClosed() {
		t.Fatalf("reconnect: reader=%d reason=%s", id, reason)
	}
	// A configured writer masquerading as a reader must be rejected.
	wrong := NewMonitor(writer, []string{writer}, policy, nil)
	defer wrong.Close()
	wrong.Refresh(ctx)
	if ok, _ := wrong.Status(0).Eligible(time.Now(), policy); ok {
		t.Fatal("primary accepted as standby")
	}
}

// Explicit opt-in: pauses WAL replay on the first replica, always resumes it,
// and generates WAL via a rolled-back update (no visible row changes).
func TestReaderReplayLagIntegration(t *testing.T) {
	if os.Getenv("DBMESH_TEST_REPLICATION_CONTROL") != "1" {
		t.Skip("set DBMESH_TEST_REPLICATION_CONTROL=1 to pause replica replay")
	}
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Fatal("database URLs required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	urls := strings.Split(readers, ",")
	admin, err := pgconn.Connect(ctx, urls[0])
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(context.Background())
	exec := func(conn *pgconn.PgConn, sql string) {
		t.Helper()
		if _, err := conn.Exec(ctx, sql).ReadAll(); err != nil {
			t.Fatal(err)
		}
	}
	defer func() {
		cleanupCtx, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if _, err := admin.Exec(cleanupCtx, "SELECT pg_wal_replay_resume()").ReadAll(); err != nil {
			t.Errorf("could not resume replica: %v", err)
		}
	}()
	exec(admin, "SELECT pg_wal_replay_pause()")
	for {
		rows, err := admin.Exec(ctx, "SELECT pg_get_wal_replay_pause_state()").ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		if string(rows[0].Rows[0][0]) == "paused" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	primary, err := pgconn.Connect(ctx, writer)
	if err != nil {
		t.Fatal(err)
	}
	defer primary.Close(context.Background())
	exec(primary, "BEGIN; UPDATE users SET plan=plan WHERE id=1; ROLLBACK;")
	exec(primary, "SELECT pg_switch_wal()")
	policy := config.DefaultReaderPolicy()
	policy.MaxLagBytes = 0
	m := NewMonitor(writer, urls, policy, nil)
	defer m.Close()
	m.Refresh(ctx)
	status := m.Status(0)
	if ok, reason := status.Eligible(time.Now(), policy); ok || reason != "replication lag exceeds limit" {
		t.Fatalf("paused replica: %+v reason=%s", status, reason)
	}
	s, err := Connect(ctx, writer, urls[:1], "demo", m)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close(ctx)
	if _, id, reason := s.Reader(ctx); id != 0 {
		t.Fatalf("lagged reader chosen: %d %s", id, reason)
	}
	exec(admin, "SELECT pg_wal_replay_resume()")
	for {
		m.Refresh(ctx)
		if ok, _ := m.Status(0).Eligible(time.Now(), policy); ok {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
	if _, id, reason := s.Reader(ctx); id != 1 {
		t.Fatalf("recovered reader not selected: %d %s", id, reason)
	}
}
