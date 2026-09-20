package upstream

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"dbmesh/internal/config"
	"github.com/jackc/pgx/v5/pgconn"
)

// ReaderStatus is a snapshot, never a guarantee of read-after-write consistency.
type ReaderStatus struct {
	SampledAt  time.Time
	Generation uint64
	LagBytes   uint64
	Valid      bool
	Reason     string
}

func (s ReaderStatus) Eligible(now time.Time, policy config.ReaderPolicy) (bool, string) {
	if !s.Valid {
		if s.Reason == "" {
			return false, "not yet checked"
		}
		return false, s.Reason
	}
	if s.SampledAt.IsZero() || now.Sub(s.SampledAt) > policy.StatusMaxAge {
		return false, "stale monitoring sample"
	}
	if s.LagBytes > uint64(policy.MaxLagBytes) {
		return false, "replication lag exceeds limit"
	}
	return true, ""
}

// Monitor owns dedicated connections; Refresh and Run must not run concurrently.
// Only the published status snapshots are shared with client sessions.
type Monitor struct {
	policy     config.ReaderPolicy
	writerURL  string
	readerURLs []string
	writer     *pgconn.PgConn
	readers    []*pgconn.PgConn
	mu         sync.RWMutex
	statuses   []ReaderStatus
	logger     *slog.Logger
}

func NewMonitor(writer string, readers []string, policy config.ReaderPolicy, logger *slog.Logger) *Monitor {
	return &Monitor{writerURL: writer, readerURLs: readers, policy: policy,
		readers: make([]*pgconn.PgConn, len(readers)), statuses: make([]ReaderStatus, len(readers)), logger: logger}
}

func (m *Monitor) Status(index int) ReaderStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.statuses[index]
}

func (m *Monitor) Run(ctx context.Context) {
	defer m.Close()
	m.Refresh(ctx)
	ticker := time.NewTicker(m.policy.CheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.Refresh(ctx)
		}
	}
}

func (m *Monitor) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), m.policy.CheckTimeout)
	defer cancel()
	if m.writer != nil {
		_ = m.writer.Close(ctx)
	}
	for _, conn := range m.readers {
		if conn != nil {
			_ = conn.Close(ctx)
		}
	}
}

func (m *Monitor) publish(index int, status ReaderStatus) {
	m.mu.Lock()
	previous := m.statuses[index]
	status.Generation = previous.Generation
	if previous.Valid && !status.Valid {
		status.Generation++
	}
	m.statuses[index] = status
	m.mu.Unlock()
	ok, reason := status.Eligible(time.Now(), m.policy)
	oldOK, oldReason := previous.Eligible(time.Now(), m.policy)
	if m.logger != nil && (ok != oldOK || reason != oldReason) {
		m.logger.Info("reader status changed", "reader", index+1, "eligible", ok,
			"lag_bytes", status.LagBytes, "reason", reason)
	}
}

// Sample the primary before the readers. A reader may have advanced beyond this
// sampled LSN; clamp that distance to zero. Both endpoints must belong to the
// same replication cluster/timeline (automatic failover is out of scope).
func (m *Monitor) Refresh(ctx context.Context) {
	if len(m.readers) == 0 {
		return
	}
	sampledAt := time.Now()
	primary, err := m.probe(ctx, &m.writer, m.writerURL,
		"SELECT pg_is_in_recovery(), pg_current_wal_lsn()")
	if err != nil || len(primary) != 2 || string(primary[0]) != "f" {
		for i := range m.readers {
			m.publish(i, ReaderStatus{Reason: "primary WAL position unavailable"})
		}
		return
	}
	primaryLSN, err := parseLSN(string(primary[1]))
	if err != nil {
		for i := range m.readers {
			m.publish(i, ReaderStatus{Reason: "invalid primary WAL position"})
		}
		return
	}
	var wg sync.WaitGroup
	for i := range m.readers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			row, err := m.probe(ctx, &m.readers[i], m.readerURLs[i],
				"SELECT pg_is_in_recovery(), pg_last_wal_replay_lsn()")
			status := ReaderStatus{SampledAt: sampledAt}
			switch {
			case err != nil:
				status.Reason = "reader check failed"
			case len(row) != 2 || string(row[0]) != "t":
				status.Reason = "reader is not a standby"
			default:
				replay, err := parseLSN(string(row[1]))
				if err != nil {
					status.Reason = "replay WAL position unavailable"
				} else {
					status.Valid = true
					if primaryLSN > replay {
						status.LagBytes = primaryLSN - replay
					}
				}
			}
			m.publish(i, status)
		}(i)
	}
	wg.Wait()
}

func (m *Monitor) probe(parent context.Context, conn **pgconn.PgConn, dsn, sql string) ([][]byte, error) {
	ctx, cancel := context.WithTimeout(parent, m.policy.CheckTimeout)
	defer cancel()
	if *conn == nil || (*conn).IsClosed() {
		var err error
		*conn, err = pgconn.Connect(ctx, dsn)
		if err != nil {
			return nil, err
		}
	}
	results, err := (*conn).Exec(ctx, sql).ReadAll()
	if err != nil {
		_ = (*conn).Close(ctx)
		*conn = nil
		return nil, err
	}
	if len(results) != 1 || len(results[0].Rows) != 1 {
		return nil, fmt.Errorf("unexpected monitoring result")
	}
	return results[0].Rows[0], nil
}

func parseLSN(raw string) (uint64, error) {
	parts := strings.Split(raw, "/")
	if len(parts) != 2 {
		return 0, fmt.Errorf("invalid LSN")
	}
	high, err := strconv.ParseUint(parts[0], 16, 32)
	if err != nil {
		return 0, err
	}
	low, err := strconv.ParseUint(parts[1], 16, 32)
	if err != nil {
		return 0, err
	}
	return high<<32 | low, nil
}
