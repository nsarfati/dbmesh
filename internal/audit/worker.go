package audit

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Dispatcher starts the delivery worker and outbox cleaner for one database as
// soon as its outbox exists, including after restart when no application
// reconnects. Wake asks it to check again without waiting for the next tick.
type Dispatcher struct {
	WriterURL, Database, DestinationURL string
	Retention, CleanupInterval          time.Duration
	CleanupBatch                        int
	Logger                              *slog.Logger
	Wake                                chan struct{}
}

func (d *Dispatcher) Run(ctx context.Context) {
	var wg sync.WaitGroup
	defer wg.Wait()
	started := false
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		if !started {
			scanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			exists, err := d.hasOutbox(scanCtx)
			cancel()
			if err != nil && ctx.Err() == nil {
				d.Logger.Warn("audit discovery failed", "database", d.Database, "err", err)
			}
			if exists {
				started = true
				wg.Add(1)
				go func() {
					defer wg.Done()
					sink := NewPostgresSink(d.DestinationURL)
					defer sink.Close()
					w := Worker{WriterURL: d.WriterURL, Database: d.Database, Sink: sink, Logger: d.Logger, PollInterval: 5 * time.Second}
					w.Run(ctx)
				}()
				if d.Retention > 0 {
					wg.Add(1)
					go func() {
						defer wg.Done()
						c := Cleaner{WriterURL: d.WriterURL, Database: d.Database, Retention: d.Retention,
							Interval: d.CleanupInterval, BatchSize: d.CleanupBatch, Logger: d.Logger}
						c.Run(ctx)
					}()
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-d.Wake:
		}
	}
}

func (d *Dispatcher) hasOutbox(ctx context.Context) (bool, error) {
	conn, err := connectDB(ctx, d.WriterURL, d.Database)
	if err != nil {
		return false, err
	}
	defer closeDB(conn)
	var exists bool
	err = conn.QueryRow(ctx, "SELECT to_regclass('dbmesh.audit_outbox') IS NOT NULL").Scan(&exists)
	return exists, err
}

type Worker struct {
	WriterURL, Database string
	Sink                RowSink
	Logger              *slog.Logger
	PollInterval        time.Duration
}

func (w *Worker) Run(ctx context.Context) {
	for ctx.Err() == nil {
		err := w.listen(ctx)
		if err != nil && ctx.Err() == nil {
			w.Logger.Warn("audit worker reconnecting", "database", w.Database, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (w *Worker) listen(ctx context.Context) error {
	conn, err := connectDB(ctx, w.WriterURL, w.Database)
	if err != nil {
		return err
	}
	defer closeDB(conn)
	// LISTEN commits before the initial scan, closing the subscription/scan race.
	if _, err = conn.Exec(ctx, "SELECT set_config('application_name',$1,false)", "dbmesh-audit-listener:"+w.Sink.Name()); err != nil {
		return err
	}
	if _, err = conn.Exec(ctx, "LISTEN dbmesh_audit_pending"); err != nil {
		return err
	}
	poll := w.PollInterval
	if poll <= 0 {
		poll = 5 * time.Second
	}
	for ctx.Err() == nil {
		if err = w.Drain(ctx, conn); err != nil {
			return err
		}
		waitCtx, cancel := context.WithTimeout(ctx, poll)
		_, err = conn.WaitForNotification(waitCtx)
		cancel()
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
	}
	return ctx.Err()
}

// Drain acknowledges only after the sink accepts the event. A crash in between
// causes redelivery, not loss. No monotonically increasing cursor: transactions
// may commit in a different order than event creation.
func (w *Worker) Drain(ctx context.Context, conn *pgx.Conn) error {
	for ctx.Err() == nil {
		opCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		rows, err := conn.Query(opCtx, `SELECT o.event_id::text,o.db,o."schema",o."table",o.operation,
   o.audit_user_id,o.audit_request_id,o.audit_service,o.previous_value,o.new_value,o.created_at
   FROM dbmesh.audit_outbox o JOIN dbmesh.audit_delivery d USING(event_id)
   WHERE d.sink=$1 AND d.delivered_at IS NULL ORDER BY o.created_at,o.event_id LIMIT 100`, w.Sink.Name())
		if err != nil {
			cancel()
			return err
		}
		var events []RowEvent
		for rows.Next() {
			var e RowEvent
			if err = rows.Scan(&e.ID, &e.DB, &e.Schema, &e.Table, &e.Operation, &e.UserID, &e.RequestID, &e.Service, &e.Previous, &e.New, &e.Created); err != nil {
				rows.Close()
				cancel()
				return err
			}
			events = append(events, e)
		}
		err = rows.Err()
		rows.Close()
		cancel()
		if err != nil {
			return err
		}
		if len(events) == 0 {
			return nil
		}
		for _, e := range events {
			opCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = w.Sink.Deliver(opCtx, e)
			if err != nil && ctx.Err() == nil {
				w.recordFailure(ctx, conn, err)
			}
			if err == nil {
				_, err = conn.Exec(opCtx, "UPDATE dbmesh.audit_delivery SET delivered_at=clock_timestamp() WHERE event_id=$1 AND sink=$2 AND delivered_at IS NULL", e.ID, w.Sink.Name())
			}
			cancel()
			if err != nil {
				return err
			}
		}
		w.recordSuccess(ctx, conn)
	}
	return ctx.Err()
}

// The status table is diagnostic only: a failure to write it must not stop
// delivery, so both helpers just log.
func (w *Worker) recordFailure(ctx context.Context, conn *pgx.Conn, cause error) {
	msg := cause.Error()
	if len(msg) > 500 {
		msg = msg[:500]
	}
	w.Logger.Warn("audit sink delivery failed", "database", w.Database, "sink", w.Sink.Name(), "err", cause)
	w.upsertStatus(ctx, conn, `INSERT INTO dbmesh.audit_sink_status(sink,last_error,last_error_at)
   VALUES($1,$2,clock_timestamp()) ON CONFLICT(sink) DO UPDATE SET last_error=$2,last_error_at=clock_timestamp()`, msg)
}

func (w *Worker) recordSuccess(ctx context.Context, conn *pgx.Conn) {
	w.upsertStatus(ctx, conn, `INSERT INTO dbmesh.audit_sink_status(sink,last_success_at)
   VALUES($1,clock_timestamp()) ON CONFLICT(sink) DO UPDATE SET last_success_at=clock_timestamp()`)
}

func (w *Worker) upsertStatus(ctx context.Context, conn *pgx.Conn, sql string, args ...any) {
	opCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := conn.Exec(opCtx, sql, append([]any{w.Sink.Name()}, args...)...); err != nil {
		w.Logger.Warn("audit sink status not recorded", "database", w.Database, "sink", w.Sink.Name(), "err", err)
	}
}
