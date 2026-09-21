package proxy

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"dbmesh/internal/audit"
	"dbmesh/internal/config"
	"github.com/jackc/pgx/v5/pgconn"
)

type captureSink struct {
	mu     sync.Mutex
	events []audit.Event
	fail   bool
}

func (s *captureSink) Emit(_ context.Context, e audit.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("sink unavailable")
	}
	s.events = append(s.events, e)
	return nil
}
func (s *captureSink) snapshot() []audit.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]audit.Event(nil), s.events...)
}

func TestAuditIntegration(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	sink := &captureSink{}
	server := NewServer(config.Config{WriterURL: writer, ReaderURLs: strings.Split(readers, ",")}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	server.auditSink = sink
	server.monitor.Refresh(ctx)
	defer server.monitor.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			err = server.handleClient(ctx, conn)
		}
		done <- err
	}()
	conn, err := pgconn.Connect(ctx, "postgres://routepg@"+ln.Addr().String()+"/demo?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = conn.Close(ctx)
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, io.EOF) {
				t.Error(err)
			}
		case <-ctx.Done():
			t.Error(ctx.Err())
		}
	}()
	if conn.ParameterStatus("dbmesh_audit") != "comment-v1" {
		t.Fatal("missing capability")
	}
	exec := func(query string, wantFailure bool) []*pgconn.Result {
		t.Helper()
		results, err := conn.Exec(ctx, query).ReadAll()
		if (err != nil) != wantFailure {
			t.Fatalf("query %q: %v", query, err)
		}
		return results
	}
	header := "/*dbmesh:v1:" + base64.RawURLEncoding.EncodeToString([]byte(`{"user_id":"812","request_id":"req-1","service":"billing"}`)) + "*/\n"
	exec(header+"SELECT * FROM users WHERE id=1", false)
	exec(header+"UPDATE users SET plan=plan WHERE false", false)
	exec(header+"SELECT 1/0", true)
	events := sink.snapshot()
	if len(events) != 3 {
		t.Fatalf("events=%d", len(events))
	}
	if events[0].Target != "replica" || events[0].Reader == 0 || events[1].Target != "primary" || events[1].Commands[0] != "UPDATE 0" {
		t.Fatalf("wrong routing or commands: %+v", events)
	}
	if events[2].Outcome != "error" || events[2].SQLState != "22012" {
		t.Fatalf("error event: %+v", events[2])
	}
	for _, e := range events {
		if e.Context.UserID != "812" || e.Database != "demo" || strings.Contains(e.SQL, "dbmesh:v1:") || e.QueryID == "" || e.ConnectionID == "" {
			t.Fatalf("invalid event: %+v", e)
		}
	}
	if events[0].QueryID == events[1].QueryID || events[0].ConnectionID != events[1].ConnectionID {
		t.Fatal("incorrect correlation IDs")
	}
	// A plain query must not inherit the previous request, even after an error.
	exec("SELECT 1", false)
	if len(sink.snapshot()) != 3 {
		t.Fatal("context leaked to next query")
	}
	// Context does not change transaction semantics or claim a committed update.
	exec(header+"BEGIN", false)
	exec(header+"UPDATE users SET plan=plan WHERE false", false)
	exec(header+"ROLLBACK", false)
	events = sink.snapshot()
	if events[4].Outcome != "success" || events[4].TxBefore != "T" || events[4].TxAfter != "T" || events[5].Commands[0] != "ROLLBACK" {
		t.Fatalf("transaction audit: %+v", events[3:])
	}
	// The header is masked rather than deleted: error positions still align.
	_, err = conn.Exec(ctx, header+"SELECT 1 +").ReadAll()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "42601" || pgErr.Position <= int32(len(header)) {
		t.Fatalf("error position lost: %v", err)
	}
	before := len(sink.snapshot())
	exec("/*dbmesh:v1:invalid!*/ SELECT 1", true)
	if len(sink.snapshot()) != before {
		t.Fatal("malformed context emitted as valid audit")
	}
	// The envelope is message-scoped, including all results of a batch.
	results := exec(header+"SELECT 1; SELECT 2", false)
	if len(results) != 2 {
		t.Fatal("batch results lost")
	}
	events = sink.snapshot()
	if got := fmt.Sprint(events[len(events)-1].Commands); got != "[SELECT 1 SELECT 1]" {
		t.Fatal(got)
	}
	// Logging failure must never disguise successful SQL as a retryable failure.
	sink.mu.Lock()
	sink.fail = true
	sink.mu.Unlock()
	exec(header+"SELECT 42", false)
}
