package proxy

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/nsarfati/dbmesh/internal/config"
)

func rowAuditConfig(t *testing.T, writer, readers, dest string) config.Config {
	cfg := testConfig(t, writer, readers)
	cfg.Audit = config.Audit{Sinks: []string{"postgres"}, DatabaseURL: dest, CleanupInterval: time.Minute, CleanupBatch: 100} // Retention 0: never clean shared test data
	return cfg
}

func TestRowAuditIntegration(t *testing.T) {
	writer, dest := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_AUDIT_URL")
	if writer == "" || dest == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_AUDIT_URL")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	source, err := pgx.Connect(ctx, writer)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close(context.Background())
	schema := fmt.Sprintf("rowaudit_%d", time.Now().UnixNano())
	_, err = source.Exec(ctx, "CREATE SCHEMA "+schema+"; CREATE TABLE "+schema+".a(id int primary key, value text); CREATE TABLE "+schema+".b(id int primary key, value text)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = source.Exec(context.Background(), `DELETE FROM dbmesh.audit_delivery WHERE event_id IN (SELECT event_id FROM dbmesh.audit_outbox WHERE "schema"=$1)`, schema)
		_, _ = source.Exec(context.Background(), `DELETE FROM dbmesh.audit_outbox WHERE "schema"=$1`, schema)
		_, _ = source.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	}()
	sink, err := pgx.Connect(ctx, dest)
	if err != nil {
		t.Fatal(err)
	}
	defer sink.Close(context.Background())
	defer func() {
		_, _ = sink.Exec(context.Background(), `DELETE FROM public.audit_events WHERE "schema"=$1`, schema)
	}()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := NewServer(rowAuditConfig(t, writer, os.Getenv("DBMESH_TEST_READER_URLS"), dest), slog.New(slog.NewTextHandler(io.Discard, nil)))
	refreshMonitors(ctx, srv)
	defer closeMonitors(srv)
	runCtx, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); srv.databases[source.Config().Database].dispatcher.Run(runCtx) }()
	go func() {
		defer wg.Done()
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			wg.Add(1)
			go func() { defer wg.Done(); _ = srv.handleClient(runCtx, c) }()
		}
	}()
	defer func() { stop(); ln.Close(); wg.Wait() }()
	dial := func(table string) (*pgconn.PgConn, error) {
		cfg, e := pgconn.ParseConfig("postgres://dbmesh@" + ln.Addr().String() + "/" + source.Config().Database + "?sslmode=disable")
		if e != nil {
			return nil, e
		}
		cfg.RuntimeParams["options"] = "-c dbmesh.audit_tables=" + table
		return pgconn.ConnectConfig(ctx, cfg)
	}
	// Simultaneous preparation of the same table must not race on DDL.
	var clients [2]*pgconn.PgConn
	var errs [2]error
	var prep sync.WaitGroup
	for i := range clients {
		prep.Add(1)
		go func(i int) { defer prep.Done(); clients[i], errs[i] = dial(schema + ".a") }(i)
	}
	prep.Wait()
	for i, c := range clients {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		defer c.Close(context.Background())
	}
	a := clients[0]
	b, err := dial(schema + ".b")
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close(context.Background())
	if a.ParameterStatus("dbmesh_audit_tables") != schema+".a" {
		t.Fatal("selection not acknowledged")
	}
	if bad, e := dial(schema + ".missing"); e == nil {
		bad.Close(ctx)
		t.Fatal("accepted missing table")
	}
	header := func(request string) string {
		return "/*dbmesh:v1:" + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"user_id":"812","request_id":%q,"service":"billing"}`, request))) + "*/"
	}
	exec := func(c *pgconn.PgConn, request, query string, fail bool) {
		t.Helper()
		if request != "" {
			query = header(request) + query
		}
		_, e := c.Exec(ctx, query).ReadAll()
		if (e != nil) != fail {
			t.Fatalf("%s: %v", query, e)
		}
	}
	exec(a, "insert", "INSERT INTO "+schema+".a VALUES(1,'old')", false)
	exec(a, "skip", "INSERT INTO "+schema+".b VALUES(1,'not-selected')", false)
	exec(b, "insert-b", "INSERT INTO "+schema+".b VALUES(2,'selected')", false)
	exec(b, "skip-b", "UPDATE "+schema+".a SET value='outside' WHERE id=1", false)
	exec(a, "update", "UPDATE "+schema+".a SET value='new' WHERE id=1", false)
	exec(a, "", "BEGIN", false)
	exec(a, "rollback", "UPDATE "+schema+".a SET value='discard' WHERE id=1", false)
	exec(a, "", "ROLLBACK", false)
	exec(a, "", "BEGIN", false)
	exec(a, "", "SAVEPOINT s", false)
	exec(a, "savepoint", "UPDATE "+schema+".a SET value='discard-again' WHERE id=1", false)
	exec(a, "error", "SELECT 1/0", true)
	exec(a, "", "ROLLBACK TO s", false)
	exec(a, "", "UPDATE "+schema+".a SET value='no-context' WHERE id=1", false)
	exec(a, "", "COMMIT", false)
	exec(a, "delete", "DELETE FROM "+schema+".a WHERE id=1", false)
	exec(a, "truncate", "TRUNCATE "+schema+".a", true)
	exec(a, "batch", "BEGIN; INSERT INTO "+schema+".a VALUES(99,'bad'); COMMIT", true)
	// Reconnect to remove the deliberately conservative sticky function routing.
	read, err := dial(schema + ".a")
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close(context.Background())
	exec(read, "", "SELECT 1", false)
	var count int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		err = sink.QueryRow(ctx, `SELECT count(*) FROM public.audit_events WHERE "schema"=$1`, schema).Scan(&count)
		if err == nil && count == 5 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if count != 5 {
		t.Fatalf("delivered=%d err=%v", count, err)
	}
	var old, newValue, user, table string
	err = sink.QueryRow(ctx, `SELECT previous_value->>'value',new_value->>'value',audit_user_id,"table"
  FROM public.audit_events WHERE "schema"=$1 AND audit_request_id='update'`, schema).Scan(&old, &newValue, &user, &table)
	if err != nil || old != "outside" || newValue != "new" || user != "812" || table != "a" {
		t.Fatalf("row images: %s %s %s %s %v", old, newValue, user, table, err)
	}
	var noContext int
	err = sink.QueryRow(ctx, `SELECT count(*) FROM public.audit_events WHERE "schema"=$1 AND audit_user_id IS NULL AND audit_request_id IS NULL AND new_value->>'value'='no-context'`, schema).Scan(&noContext)
	if err != nil || noContext != 1 {
		t.Fatalf("context leaked: %d %v", noContext, err)
	}
	var images int
	err = sink.QueryRow(ctx, `SELECT count(*) FROM public.audit_events WHERE "schema"=$1 AND
  ((operation='INSERT' AND previous_value IS NULL AND new_value IS NOT NULL) OR
   (operation='DELETE' AND new_value IS NULL AND previous_value->>'value'='no-context'))`, schema).Scan(&images)
	if err != nil || images != 3 {
		t.Fatalf("insert/delete images=%d err=%v", images, err)
	}
}
