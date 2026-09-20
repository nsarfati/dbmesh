package upstream

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"dbmesh/internal/config"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestRequestedDatabaseOnAllUpstreams(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	urls := strings.Split(readers, ",")
	monitor := NewMonitor(writer, urls, config.DefaultReaderPolicy(), nil)
	defer monitor.Close()
	monitor.Refresh(ctx)
	session, err := Connect(ctx, writer, urls, "postgres", monitor)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(ctx)
	connections := []*pgconn.PgConn{session.Writer()}
	for i := range urls {
		conn, id, reason := session.Reader(ctx)
		if id != i+1 {
			t.Fatalf("reader=%d: %s", id, reason)
		}
		connections = append(connections, conn)
	}
	for i, conn := range connections {
		results, err := conn.Exec(ctx, "SELECT current_database()").ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || len(results[0].Rows) != 1 {
			t.Fatalf("unexpected results: %v", results)
		}
		result := results[0]
		if got := string(result.Rows[0][0]); got != "postgres" {
			t.Fatalf("upstream %d database=%q; want postgres", i, got)
		}
	}
}
