package audit

import (
	"context"
	"log/slog"
	"time"
)

// Event describes a Simple Query message, not a durable row-change record.
// Success means the server completed the message; transaction status remains
// separate because a later ROLLBACK can undo successful statements.
type Event struct {
	Time         time.Time
	QueryID      string
	ConnectionID string
	Context      Context
	Database     string
	ClientUser   string
	ClientAddr   string
	SQL          string
	Target       string
	Reader       int
	Duration     time.Duration
	Outcome      string // success, error, or unknown after transport failure
	SQLState     string
	Commands     []string
	Rows         int64
	TxBefore     string
	TxAfter      string
}

// Sink implementations must be safe for concurrent use and honor cancellation.
// The MVP emits synchronously and logs sink failures without retrying SQL.
type Sink interface {
	Emit(context.Context, Event) error
}

type LogSink struct{ Logger *slog.Logger }

func (s LogSink) Emit(ctx context.Context, e Event) error {
	if !s.Logger.Enabled(ctx, slog.LevelInfo) {
		return nil
	}
	r := slog.NewRecord(e.Time, slog.LevelInfo, "query audited", 0)
	r.AddAttrs(
		slog.String("query_id", e.QueryID), slog.String("connection_id", e.ConnectionID),
		slog.String("user_id", e.Context.UserID), slog.String("request_id", e.Context.RequestID),
		slog.String("service", e.Context.Service), slog.String("database", e.Database),
		slog.String("client_user", e.ClientUser), slog.String("client_addr", e.ClientAddr),
		slog.String("sql", e.SQL), slog.String("target", e.Target), slog.Int("reader", e.Reader),
		slog.Duration("duration", e.Duration), slog.String("outcome", e.Outcome),
		slog.String("sqlstate", e.SQLState), slog.Any("commands", e.Commands), slog.Int64("rows", e.Rows),
		slog.String("tx_before", e.TxBefore), slog.String("tx_after", e.TxAfter),
	)
	return s.Logger.Handler().Handle(ctx, r)
}
