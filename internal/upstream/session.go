package upstream

import (
	"context"
	"fmt"
	"sync/atomic"

	"github.com/jackc/pgx/v5/pgconn"
)

type Session struct {
	writer  *pgconn.PgConn
	readers []*pgconn.PgConn
	next    atomic.Uint64
}

func Connect(ctx context.Context, writerURL string, readerURLs []string, database string) (*Session, error) {
	writer, err := connectDatabase(ctx, writerURL, database)
	if err != nil {
		return nil, fmt.Errorf("connect writer: %w", err)
	}

	s := &Session{writer: writer}
	for _, readerURL := range readerURLs {
		reader, err := connectDatabase(ctx, readerURL, database)
		if err != nil {
			s.Close(context.Background())
			return nil, fmt.Errorf("connect reader: %w", err)
		}
		s.readers = append(s.readers, reader)
	}

	return s, nil
}

// Parse the configured DSN so database names are never interpolated into URLs.
// Hosts, credentials and connection options remain controlled by DBMesh.
func connectDatabase(ctx context.Context, dsn, database string) (*pgconn.PgConn, error) {
	cfg, err := pgconn.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	cfg.Database = database
	return pgconn.ConnectConfig(ctx, cfg)
}

func (s *Session) Writer() *pgconn.PgConn {
	return s.writer
}

func (s *Session) Reader() *pgconn.PgConn {
	if len(s.readers) == 0 {
		return s.writer
	}
	idx := int(s.next.Add(1)-1) % len(s.readers)
	return s.readers[idx]
}

func (s *Session) Close(ctx context.Context) {
	if s.writer != nil {
		_ = s.writer.Close(ctx)
	}
	for _, reader := range s.readers {
		_ = reader.Close(ctx)
	}
}
