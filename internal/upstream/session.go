package upstream

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type Session struct {
	writer           *pgconn.PgConn
	readers          []*pgconn.PgConn
	next             int
	readerURLs       []string
	database         string
	monitor          *Monitor
	retryAfter       []time.Time
	readerGeneration []uint64
}

func Connect(ctx context.Context, writerURL string, readerURLs []string, database string, monitor *Monitor) (*Session, error) {
	writer, err := connectDatabase(ctx, writerURL, database)
	if err != nil {
		return nil, fmt.Errorf("connect writer: %w", err)
	}

	s := &Session{writer: writer, readerURLs: readerURLs, database: database, monitor: monitor,
		readers: make([]*pgconn.PgConn, len(readerURLs)), retryAfter: make([]time.Time, len(readerURLs)), readerGeneration: make([]uint64, len(readerURLs))}
	// Reader connections are opened lazily; an unavailable reader cannot reject
	// a client whose primary connection succeeded.

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

// Reader returns the actual connection, a one-based reader ID (zero means
// primary), and the selection/fallback reason. It never retries a user query.
func (s *Session) Reader(ctx context.Context) (*pgconn.PgConn, int, string) {
	if len(s.readers) == 0 {
		return s.writer, 0, "no readers configured"
	}
	if s.monitor == nil {
		return s.writer, 0, "reader monitoring unavailable"
	}
	reasons := make([]string, 0, len(s.readers))
	start := s.next
	for offset := 0; offset < len(s.readers); offset++ {
		i := (start + offset) % len(s.readers)
		status := s.monitor.Status(i)
		ok, reason := status.Eligible(time.Now(), s.monitor.policy)
		if ok && time.Now().Before(s.retryAfter[i]) {
			ok, reason = false, "reader connection retry pending"
		}
		// A monitor-observed outage invalidates older session sockets, even if
		// they have not yet noticed the remote disconnect.
		if ok && s.readers[i] != nil && s.readerGeneration[i] != status.Generation {
			closeCtx, cancel := context.WithTimeout(ctx, s.monitor.policy.CheckTimeout)
			_ = s.readers[i].Close(closeCtx)
			cancel()
			s.readers[i] = nil
		}
		if ok && (s.readers[i] == nil || s.readers[i].IsClosed()) {
			dialCtx, cancel := context.WithTimeout(ctx, s.monitor.policy.CheckTimeout)
			conn, err := connectDatabase(dialCtx, s.readerURLs[i], s.database)
			cancel()
			if err != nil {
				s.retryAfter[i] = time.Now().Add(s.monitor.policy.CheckInterval)
				ok, reason = false, "reader connection failed"
			} else {
				s.readers[i] = conn
				s.readerGeneration[i] = status.Generation
			}
		}
		// A connection attempt may outlive the sample's freshness window.
		if ok {
			latest := s.monitor.Status(i)
			ok, reason = latest.Eligible(time.Now(), s.monitor.policy)
			if ok && latest.Generation != s.readerGeneration[i] {
				ok, reason = false, "reader changed during connection attempt"
			}
		}
		if ok {
			s.next = (i + 1) % len(s.readers)
			return s.readers[i], i + 1, "healthy reader"
		}
		reasons = append(reasons, fmt.Sprintf("reader %d: %s", i+1, reason))
	}
	return s.writer, 0, "no eligible readers; " + strings.Join(reasons, "; ")
}

func (s *Session) Close(ctx context.Context) {
	if s.writer != nil {
		_ = s.writer.Close(ctx)
	}
	for _, reader := range s.readers {
		if reader != nil {
			_ = reader.Close(ctx)
		}
	}
}
