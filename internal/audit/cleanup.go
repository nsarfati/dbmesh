package audit

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
)

// Cleaner removes outbox events in small batches. An event is removable only
// when every sink has acknowledged it and the last acknowledgement is older
// than Retention, so an unfinished sink never loses history.
type Cleaner struct {
	WriterURL, Database string
	Retention, Interval time.Duration
	BatchSize           int
	Logger              *slog.Logger
}

const cleanupSQL = `WITH batch AS (
  SELECT o.event_id FROM dbmesh.audit_outbox o
  WHERE o.created_at < clock_timestamp() - make_interval(secs => $1)
    AND NOT EXISTS (SELECT 1 FROM dbmesh.audit_delivery d WHERE d.event_id = o.event_id
      AND (d.delivered_at IS NULL OR d.delivered_at >= clock_timestamp() - make_interval(secs => $1)))
  ORDER BY o.created_at LIMIT $2
  FOR UPDATE OF o SKIP LOCKED
), gone AS (
  DELETE FROM dbmesh.audit_delivery WHERE event_id IN (SELECT event_id FROM batch)
)
DELETE FROM dbmesh.audit_outbox WHERE event_id IN (SELECT event_id FROM batch)`

func (c *Cleaner) Run(ctx context.Context) {
	for ctx.Err() == nil {
		if err := c.loop(ctx); err != nil && ctx.Err() == nil {
			c.Logger.Warn("audit cleanup failed", "database", c.Database, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.Interval):
		}
	}
}

func (c *Cleaner) loop(ctx context.Context) error {
	conn, err := connectDB(ctx, c.WriterURL, c.Database)
	if err != nil {
		return err
	}
	defer closeDB(conn)
	ticker := time.NewTicker(c.Interval)
	defer ticker.Stop()
	for {
		if _, err := c.Sweep(ctx, conn); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Sweep deletes eligible events until a batch comes back short and returns how
// many outbox rows were removed. Each batch is its own transaction.
func (c *Cleaner) Sweep(ctx context.Context, conn *pgx.Conn) (int64, error) {
	var total int64
	for ctx.Err() == nil {
		opCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		tag, err := conn.Exec(opCtx, cleanupSQL, c.Retention.Seconds(), c.BatchSize)
		cancel()
		if err != nil {
			return total, err
		}
		total += tag.RowsAffected()
		if tag.RowsAffected() < int64(c.BatchSize) {
			break
		}
	}
	if total > 0 {
		c.Logger.Info("audit outbox cleaned", "database", c.Database, "events", total)
	}
	return total, ctx.Err()
}
