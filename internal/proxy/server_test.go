package proxy

import (
	"context"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	"dbmesh/internal/config"
)

// Opt-in integration coverage using the real primary and streaming readers.
// No schema changes or persistent writes are needed.
func TestASTRoutingIntegration(t *testing.T) {
	writer := os.Getenv("DBMESH_TEST_WRITER_URL")
	readers := os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	server := NewServer(config.Config{WriterURL: writer, ReaderURLs: strings.Split(readers, ",")},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			err = server.handleClient(ctx, conn)
		}
		done <- err
	}()
	cfg, err := pgconn.ParseConfig("postgres://routepg@" + ln.Addr().String() + "/demo?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	var notices []string
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) { notices = append(notices, n.Message) }
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = conn.Close(ctx)
		select {
		case err := <-done:
			if err != nil && err != io.EOF {
				t.Errorf("server: %v", err)
			}
		case <-ctx.Done():
			t.Error("server did not stop")
		}
	}()
	for _, tt := range []struct {
		sql, route string
		status     byte
		fail       bool
		results    int
	}{
		{"SELECT 1", "replica", 'I', false, 1},
		{"WITH x AS (SELECT 1 AS n) SELECT n FROM x", "replica", 'I', false, 1},
		{"SELECT 1; UPDATE users SET plan=plan WHERE false", "primary", 'I', false, 2},
		{"WITH x AS (UPDATE users SET plan=plan WHERE false RETURNING id) SELECT * FROM x", "primary", 'I', false, 1},
		{"BEGIN; SELECT 1", "primary", 'T', false, 2},
		{"SELECT 1", "primary", 'T', false, 1},
		{"COMMIT; BEGIN", "primary", 'T', false, 2},
		{"SAVEPOINT x", "primary", 'T', false, 1},
		{"SELECT 1/0", "primary", 'E', true, 0},
		{"ROLLBACK TO x", "primary", 'T', false, 1},
		{"COMMIT AND CHAIN", "primary", 'T', false, 1},
		{"ROLLBACK", "primary", 'I', false, 1},
		{"SELECT 1", "replica", 'I', false, 1},
		{"BEGIN; SELECT 1/0", "primary", 'E', true, 1},
		{"SELECT 1", "primary", 'E', true, 0},
		{"ROLLBACK", "primary", 'I', false, 1},
		{"SELECT 1", "replica", 'I', false, 1},
		{"SET application_name='ast-test'; SELECT 1/0", "primary", 'I', true, 1},
		{"SELECT 1", "primary", 'I', false, 1},
	} {
		t.Run(tt.sql, func(t *testing.T) {
			notices = nil
			results, err := conn.Exec(ctx, tt.sql).ReadAll()
			if (err != nil) != tt.fail {
				t.Fatalf("err=%v; want failure=%v", err, tt.fail)
			}
			if len(results) != tt.results {
				t.Fatalf("results=%d; want %d", len(results), tt.results)
			}
			if conn.TxStatus() != tt.status {
				t.Fatalf("status=%c; want %c", conn.TxStatus(), tt.status)
			}
			if len(notices) != 1 || !strings.Contains(notices[0], "dbmesh -> "+tt.route+" (") {
				t.Fatalf("notices=%v; want %s", notices, tt.route)
			}
		})
	}
}

// Exercise startup directly so an omitted database is not filled in by a client
// library before it reaches DBMesh.
func TestDatabaseStartupIntegration(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	for _, tt := range []struct {
		name, user, database, want string
		missing                    bool
	}{
		{"configured database", "routepg", "demo", "demo", false},
		{"different database", "routepg", "postgres", "postgres", false},
		{"omitted database defaults to user", "postgres", "", "postgres", false},
		{"missing database", "routepg", "dbmesh_missing_database_test", "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			client, upstream := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(10 * time.Second))
			server := NewServer(config.Config{WriterURL: writer, ReaderURLs: strings.Split(readers, ",")},
				slog.New(slog.NewTextHandler(io.Discard, nil)))
			done := make(chan error, 1)
			go func() { done <- server.handleClient(ctx, upstream) }()
			defer func() {
				client.Close()
				select {
				case <-done:
				case <-ctx.Done():
					t.Error("server did not stop")
				}
			}()
			frontend := pgproto3.NewFrontend(client, client)
			params := map[string]string{"user": tt.user}
			if tt.database != "" {
				params["database"] = tt.database
			}
			frontend.Send(&pgproto3.StartupMessage{ProtocolVersion: 196608, Parameters: params})
			if err := frontend.Flush(); err != nil {
				t.Fatal(err)
			}
			for {
				msg, err := frontend.Receive()
				if err != nil {
					t.Fatal(err)
				}
				if e, ok := msg.(*pgproto3.ErrorResponse); ok {
					if !tt.missing || e.Code != "3D000" || e.Severity != "FATAL" {
						t.Fatalf("unexpected startup error: %+v", e)
					}
					return
				}
				if _, ok := msg.(*pgproto3.ReadyForQuery); ok {
					if tt.missing {
						t.Fatal("accepted a nonexistent database")
					}
					break
				}
			}
			frontend.Send(&pgproto3.Query{String: "SELECT current_database()"})
			if err := frontend.Flush(); err != nil {
				t.Fatal(err)
			}
			got := ""
			for {
				msg, err := frontend.Receive()
				if err != nil {
					t.Fatal(err)
				}
				switch m := msg.(type) {
				case *pgproto3.DataRow:
					got = string(m.Values[0])
				case *pgproto3.ErrorResponse:
					t.Fatalf("query: %+v", m)
				case *pgproto3.ReadyForQuery:
					if got != tt.want {
						t.Fatalf("database=%q; want %q", got, tt.want)
					}
					return
				}
			}
		})
	}
}
