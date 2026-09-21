package audit

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"
	"time"
)

// The cleaner deletes history, so the test works in a throwaway database
// instead of the shared integration database.
func TestCleanerAndStatusIntegration(t *testing.T) {
	adminURL := os.Getenv("DBMESH_TEST_WRITER_URL")
	if adminURL == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := connectDB(ctx, adminURL, "")
	if err != nil {
		t.Fatal(err)
	}
	defer closeDB(admin)
	name := fmt.Sprintf("dbmesh_cleanup_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP DATABASE "+name+" WITH (FORCE)") }()
	db, err := connectDB(ctx, adminURL, name)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDB(db)
	if _, err = db.Exec(ctx, "CREATE TABLE public.items(id int primary key)"); err != nil {
		t.Fatal(err)
	}
	if err = Prepare(ctx, adminURL, name, []string{"public.items"}); err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 5; id++ {
		if err = SetContext(ctx, db.PgConn(), []string{"public.items"}, []string{"a", "b"}, &Context{RequestID: fmt.Sprint(id)}); err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(ctx, "INSERT INTO public.items VALUES($1)", id); err != nil {
			t.Fatal(err)
		}
	}
	// Age every event past retention, then shape its delivery state:
	//   1, 4, 5: every sink acknowledged long ago    -> removable
	//   2:       sink b never acknowledged           -> kept
	//   3:       sink b acknowledged just now        -> kept until retention passes
	if _, err = db.Exec(ctx, "UPDATE dbmesh.audit_outbox SET created_at = clock_timestamp() - interval '3 hours'"); err != nil {
		t.Fatal(err)
	}
	for _, s := range []struct {
		id, sink, when string
	}{
		{"1", "a", "2 hours"}, {"1", "b", "2 hours"},
		{"2", "a", "2 hours"},
		{"3", "a", "2 hours"}, {"3", "b", "0 seconds"},
		{"4", "a", "2 hours"}, {"4", "b", "2 hours"},
		{"5", "a", "2 hours"}, {"5", "b", "2 hours"},
	} {
		if _, err = db.Exec(ctx, `UPDATE dbmesh.audit_delivery SET delivered_at = clock_timestamp() - $3::interval
   WHERE sink=$2 AND event_id IN (SELECT event_id FROM dbmesh.audit_outbox WHERE audit_request_id=$1)`, s.id, s.sink, s.when); err != nil {
			t.Fatal(err)
		}
	}

	c := Cleaner{WriterURL: adminURL, Database: name, Retention: time.Hour, BatchSize: 1, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	removed, err := c.Sweep(ctx, db)
	if err != nil || removed != 3 {
		t.Fatalf("removed=%d err=%v; want 3 removed across batches of one", removed, err)
	}
	var kept string
	if err = db.QueryRow(ctx, "SELECT string_agg(audit_request_id, ',' ORDER BY audit_request_id) FROM dbmesh.audit_outbox").Scan(&kept); err != nil || kept != "2,3" {
		t.Fatalf("kept=%q err=%v", kept, err)
	}
	var deliveries int
	if err = db.QueryRow(ctx, "SELECT count(*) FROM dbmesh.audit_delivery").Scan(&deliveries); err != nil || deliveries != 4 {
		t.Fatalf("deliveries=%d err=%v; want the kept events' 4 rows", deliveries, err)
	}

	// Status: sink b still has event 2 pending; its last failure is recorded.
	w := Worker{WriterURL: adminURL, Database: name, Sink: &testDeliverySink{name: "b"}, Logger: c.Logger}
	w.recordFailure(ctx, db, errors.New("destination refused connection"))
	var pending int
	var age time.Duration
	var lastError *string
	var errorAt *time.Time
	if err = db.QueryRow(ctx, `SELECT pending, oldest_pending_age, last_error, last_error_at
   FROM dbmesh.audit_delivery_status WHERE sink='b'`).Scan(&pending, &age, &lastError, &errorAt); err != nil {
		t.Fatal(err)
	}
	if pending != 1 || age < 2*time.Hour || lastError == nil || *lastError != "destination refused connection" || errorAt == nil {
		t.Fatalf("status pending=%d age=%v error=%v at=%v", pending, age, lastError, errorAt)
	}
	w.recordSuccess(ctx, db)
	var success *time.Time
	if err = db.QueryRow(ctx, "SELECT last_success_at FROM dbmesh.audit_delivery_status WHERE sink='b'").Scan(&success); err != nil || success == nil {
		t.Fatalf("last_success_at=%v err=%v", success, err)
	}
}
