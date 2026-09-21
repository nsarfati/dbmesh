package audit

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

type testDeliverySink struct {
	*PostgresSink
	name        string
	unavailable atomic.Bool
	loseAck     bool
}

func (s *testDeliverySink) Name() string { return s.name }
func (s *testDeliverySink) Deliver(ctx context.Context, e RowEvent) error {
	if s.unavailable.Load() {
		return errors.New("test sink unavailable")
	}
	if err := s.PostgresSink.Deliver(ctx, e); err != nil {
		return err
	}
	if s.loseAck {
		s.loseAck = false
		return errors.New("simulated crash after destination commit")
	}
	return nil
}

func TestWorkerRecoveryIntegration(t *testing.T) {
	sourceURL, destinationURL := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_AUDIT_URL")
	if sourceURL == "" || destinationURL == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_AUDIT_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	source, err := connectDB(ctx, sourceURL, "")
	if err != nil {
		t.Fatal(err)
	}
	defer closeDB(source)
	dest, err := connectDB(ctx, destinationURL, "")
	if err != nil {
		t.Fatal(err)
	}
	defer closeDB(dest)
	schema := fmt.Sprintf("worker_%d", time.Now().UnixNano())
	if _, err = source.Exec(ctx, "CREATE SCHEMA "+schema+"; CREATE TABLE "+schema+".items(id int primary key, value text)"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = source.Exec(context.Background(), `DELETE FROM dbmesh.audit_delivery WHERE event_id IN(SELECT event_id FROM dbmesh.audit_outbox WHERE "schema"=$1)`, schema)
		_, _ = source.Exec(context.Background(), `DELETE FROM dbmesh.audit_outbox WHERE "schema"=$1`, schema)
		_, _ = source.Exec(context.Background(), "DELETE FROM dbmesh.audit_sink_status WHERE sink=$1", schema)
		_, _ = source.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		_, _ = dest.Exec(context.Background(), `DELETE FROM public.audit_events WHERE "schema"=$1`, schema)
	}()
	if err = Prepare(ctx, sourceURL, source.Config().Database, []string{schema + ".items"}); err != nil {
		t.Fatal(err)
	}
	name := schema
	sink := &testDeliverySink{PostgresSink: NewPostgresSink(destinationURL), name: name, loseAck: true}
	defer sink.Close()
	w := Worker{WriterURL: sourceURL, Database: source.Config().Database, Sink: sink, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), PollInterval: time.Hour}
	emit := func(id int) {
		t.Helper()
		if err := SetContext(ctx, source.PgConn(), []string{schema + ".items"}, []string{name}, &Context{UserID: "812", RequestID: fmt.Sprint(id)}); err != nil {
			t.Fatal(err)
		}
		if _, err := source.Exec(ctx, "INSERT INTO "+schema+".items VALUES($1,'value')", id); err != nil {
			t.Fatal(err)
		}
	}
	pending := func() int {
		t.Helper()
		var n int
		if err := source.QueryRow(ctx, "SELECT count(*) FROM dbmesh.audit_delivery WHERE sink=$1 AND delivered_at IS NULL", name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	emit(1)
	if err = w.Drain(ctx, source); err == nil {
		t.Fatal("expected lost acknowledgement")
	}
	if pending() != 1 {
		t.Fatal("acknowledged undelivered event")
	}
	var lastError string
	if err = source.QueryRow(ctx, "SELECT last_error FROM dbmesh.audit_delivery_status WHERE sink=$1", name).Scan(&lastError); err != nil || lastError != "simulated crash after destination commit" {
		t.Fatalf("recorded sink error %q: %v", lastError, err)
	}
	if err = w.Drain(ctx, source); err != nil {
		t.Fatal(err)
	}
	var succeeded bool
	if err = source.QueryRow(ctx, "SELECT last_success_at IS NOT NULL AND pending=0 FROM dbmesh.audit_delivery_status WHERE sink=$1", name).Scan(&succeeded); err != nil || !succeeded {
		t.Fatalf("success not recorded: %v", err)
	}
	var count int
	if err = dest.QueryRow(ctx, `SELECT count(*) FROM public.audit_events WHERE "schema"=$1`, schema).Scan(&count); err != nil || count != 1 {
		t.Fatalf("deduplication count=%d err=%v", count, err)
	}
	// No listener exists for this notification. Startup must recover the row.
	emit(2)
	sink.unavailable.Store(true)
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); w.Run(runCtx) }()
	defer func() { stop(); <-done }()
	time.Sleep(150 * time.Millisecond)
	if pending() != 1 {
		t.Fatal("lost event while sink unavailable")
	}
	sink.unavailable.Store(false)
	waitDelivered := func(want int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			e := dest.QueryRow(ctx, `SELECT count(*) FROM public.audit_events WHERE "schema"=$1`, schema).Scan(&count)
			if e == nil && count == want && pending() == 0 {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("delivery count=%d want=%d pending=%d", count, want, pending())
	}
	waitDelivered(2)
	// Poll interval is one hour: this event must wake the LISTEN connection.
	emit(3)
	waitDelivered(3)
	// Terminate only this test worker's listener. Reconnect must LISTEN and scan.
	var killed int
	if err = source.QueryRow(ctx, `SELECT count(*) FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1) x`, "dbmesh-audit-listener:"+name).Scan(&killed); err != nil || killed != 1 {
		t.Fatalf("listener termination=%d %v", killed, err)
	}
	emit(4)
	waitDelivered(4)
}
