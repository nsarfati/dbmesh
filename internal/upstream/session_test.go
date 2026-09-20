package upstream

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRequestedDatabaseOnAllUpstreams(t *testing.T) {
	writer, readers := os.Getenv("DBMESH_TEST_WRITER_URL"), os.Getenv("DBMESH_TEST_READER_URLS")
	if writer == "" || readers == "" {
		t.Skip("set DBMESH_TEST_WRITER_URL and DBMESH_TEST_READER_URLS")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := Connect(ctx, writer, strings.Split(readers, ","), "postgres")
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close(ctx)
	for i, conn := range append([]*pgconn.PgConn{session.Writer()}, session.readers...) {
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
