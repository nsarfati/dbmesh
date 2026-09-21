package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/nsarfati/dbmesh/internal/config"
	"github.com/nsarfati/dbmesh/internal/router"
)

// testConfig serves the writer URL's own database plus any extra names from the
// same integration servers.
func testConfig(t *testing.T, writer, readers string, extra ...string) config.Config {
	t.Helper()
	parsed, err := pgconn.ParseConfig(writer)
	if err != nil {
		t.Fatal(err)
	}
	var readerURLs []string
	if readers != "" {
		readerURLs = strings.Split(readers, ",")
	}
	cfg := config.Config{Databases: map[string]config.Database{}}
	for _, name := range append([]string{parsed.Database}, extra...) {
		cfg.Databases[name] = config.Database{WriterURL: writer, ReaderURLs: readerURLs}
	}
	return cfg
}

func refreshMonitors(ctx context.Context, s *Server) {
	for _, db := range s.databases {
		db.monitor.Refresh(ctx)
	}
}

func closeMonitors(s *Server) {
	for _, db := range s.databases {
		db.monitor.Close()
	}
}

func TestPsqlListDatabasesIntegration(t *testing.T) {
	writer := os.Getenv("DBMESH_TEST_WRITER_URL")
	if writer == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL")
	}
	psql, err := exec.LookPath("psql")
	if err != nil {
		t.Skip("psql is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	direct, err := pgconn.Connect(ctx, writer)
	if err != nil {
		t.Fatal(err)
	}
	wantVersion := direct.ParameterStatus("server_version")
	_ = direct.Close(ctx)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	server := NewServer(testConfig(t, writer, "", "postgres"), slog.New(slog.NewTextHandler(io.Discard, nil)))
	done := make(chan error, 1)
	go func() {
		for i := 0; i < 2; i++ {
			conn, e := ln.Accept()
			if e != nil {
				done <- e
				return
			}
			e = server.handleClient(ctx, conn)
			if e != nil && !errors.Is(e, io.EOF) {
				done <- e
				return
			}
		}
		done <- nil
	}()
	dsn := "postgres://dbmesh@" + ln.Addr().String() + "/postgres?sslmode=disable"
	conn, err := pgconn.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	gotVersion := conn.ParameterStatus("server_version")
	_ = conn.Close(ctx)
	if gotVersion != wantVersion {
		t.Fatalf("advertised %q; primary reports %q", gotVersion, wantVersion)
	}
	out, err := exec.CommandContext(ctx, psql, dsn, "-X", "-v", "ON_ERROR_STOP=1", "-c", `\l`).CombinedOutput()
	if err != nil {
		t.Fatalf("psql list databases: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "postgres") {
		t.Fatalf("missing database list: %s", out)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}

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
	server := NewServer(testConfig(t, writer, readers),
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	refreshMonitors(ctx, server)
	defer closeMonitors(server)
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			err = server.handleClient(ctx, conn)
		}
		done <- err
	}()
	cfg, err := pgconn.ParseConfig("postgres://dbmesh@" + ln.Addr().String() + "/demo?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	var notices, details []string
	cfg.OnNotice = func(_ *pgconn.PgConn, n *pgconn.Notice) {
		notices = append(notices, n.Message)
		details = append(details, n.Detail)
	}
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
			notices, details = nil, nil
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
			var info routeInfo
			if err := json.Unmarshal([]byte(details[0]), &info); err != nil || info.Target != tt.route {
				t.Fatalf("detail=%q err=%v; want target %s", details[0], err, tt.route)
			}
			if (info.Reader > 0) != (tt.route == "replica") || (info.LagBytes != nil) != (info.Reader > 0) {
				t.Fatalf("detail=%q: reader and lag_bytes must be set exactly for replica routes", details[0])
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
		{"configured database", "dbmesh", "demo", "demo", false},
		{"different database", "dbmesh", "postgres", "postgres", false},
		{"omitted database defaults to user", "postgres", "", "postgres", false},
		{"configured but missing upstream", "dbmesh", "dbmesh_missing_database_test", "", true},
		{"database not configured in DBMesh", "dbmesh", "not_configured", "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			client, upstream := net.Pipe()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(10 * time.Second))
			server := NewServer(testConfig(t, writer, readers, "postgres", "dbmesh_missing_database_test"),
				slog.New(slog.NewTextHandler(io.Discard, nil)))
			refreshMonitors(ctx, server)
			defer closeMonitors(server)
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

func TestRouteDetail(t *testing.T) {
	s := NewServer(config.Config{Databases: map[string]config.Database{"demo": {WriterURL: "postgres://x/demo", ReaderURLs: []string{"postgres://r/demo"}}}},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tt := range []struct {
		name     string
		target   string
		reader   int
		decision router.Decision
		want     routeInfo
	}{
		{"write", "primary", 0, router.Decision{Target: router.Primary, Reason: "write statement"},
			routeInfo{Target: "primary", Reason: "write statement", DurationUS: 1500}},
		{"replica read", "replica", 1, router.Decision{Target: router.Replica, Reason: "read-only SELECT; reader 1"},
			routeInfo{Target: "replica", Reader: 1, Reason: "read-only SELECT; reader 1", DurationUS: 1500}},
		{"fallback read", "primary", 0, router.Decision{Target: router.Replica, Reason: "no eligible readers"},
			routeInfo{Target: "primary", Reason: "no eligible readers", DurationUS: 1500, Fallback: true}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var got routeInfo
			if err := json.Unmarshal([]byte(s.routeDetail("demo", tt.target, tt.reader, tt.decision, 1500*time.Microsecond)), &got); err != nil {
				t.Fatal(err)
			}
			if tt.reader > 0 {
				if got.LagBytes == nil {
					t.Fatal("replica route lost lag_bytes")
				}
				got.LagBytes = nil // the monitor has not sampled anything in this unit test
			}
			if got != tt.want {
				t.Fatalf("got %+v; want %+v", got, tt.want)
			}
		})
	}
	if s.routeDetail("unknown", "replica", 1, router.Decision{}, 0) == "" {
		t.Fatal("unknown database must still produce a detail")
	}
}

// An empty result set must still describe its columns; clients such as psql and
// psycopg cannot build a header or a cursor description without it.
func TestEmptyResultKeepsColumnsIntegration(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	server := NewServer(testConfig(t, writer, readers), slog.New(slog.NewTextHandler(io.Discard, nil)))
	refreshMonitors(ctx, server)
	defer closeMonitors(server)
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			err = server.handleClient(ctx, conn)
		}
		done <- err
	}()
	conn, err := pgconn.Connect(ctx, "postgres://dbmesh@"+ln.Addr().String()+"/demo?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx); <-done }()
	for _, query := range []string{
		"SELECT id, name FROM users WHERE id < 0",                      // replica
		"UPDATE users SET plan = plan WHERE id < 0 RETURNING id, plan", // primary
	} {
		mrr := conn.Exec(ctx, query)
		if !mrr.NextResult() {
			t.Fatalf("%s: no result", query)
		}
		rr := mrr.ResultReader()
		fields := rr.FieldDescriptions()
		if len(fields) < 2 || fields[0].Name != "id" {
			t.Errorf("%s: fields=%v; want the column descriptions of an empty result", query, fields)
		}
		if rr.NextRow() {
			t.Errorf("%s: unexpected row", query)
		}
		if _, err := rr.Close(); err != nil {
			t.Errorf("%s: %v", query, err)
		}
		if err := mrr.Close(); err != nil {
			t.Errorf("%s: %v", query, err)
		}
	}
}

// Drivers configure themselves from the startup parameters; a proxy that drops
// them breaks timestamp decoding. The values must match a direct connection.
func TestStartupParametersMatchUpstreamIntegration(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	direct, err := pgconn.Connect(ctx, writer)
	if err != nil {
		t.Fatal(err)
	}
	defer direct.Close(ctx)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	server := NewServer(testConfig(t, writer, readers), slog.New(slog.NewTextHandler(io.Discard, nil)))
	refreshMonitors(ctx, server)
	defer closeMonitors(server)
	done := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			err = server.handleClient(ctx, conn)
		}
		done <- err
	}()
	proxied, err := pgconn.Connect(ctx, "postgres://dbmesh@"+ln.Addr().String()+"/demo?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = proxied.Close(ctx); <-done }()

	// Listed here on purpose: the test must not shrink along with the implementation.
	for _, name := range []string{"server_version", "server_encoding", "client_encoding", "DateStyle", "IntervalStyle", "TimeZone", "integer_datetimes", "standard_conforming_strings"} {
		want := direct.ParameterStatus(name)
		if want == "" {
			t.Fatalf("upstream did not report %s; the test needs a PostgreSQL that does", name)
		}
		if got := proxied.ParameterStatus(name); got != want {
			t.Errorf("%s = %q through DBMesh; %q directly", name, got, want)
		}
	}
}
