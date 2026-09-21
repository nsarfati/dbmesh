package audit

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

//go:embed source.sql
var sourceDDL string

//go:embed destination.sql
var destinationDDL string

func connectDB(ctx context.Context, dsn, database string) (*pgx.Conn, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if database != "" {
		cfg.Database = database
	}
	cfg.ConnectTimeout = 5 * time.Second
	cfg.RuntimeParams["application_name"] = "dbmesh-audit"
	return pgx.ConnectConfig(ctx, cfg)
}

func closeDB(conn *pgx.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = conn.Close(ctx)
}

// Prepare serializes installation across processes using a transaction advisory
// lock. All selected tables are validated before committing any DDL.
func Prepare(ctx context.Context, dsn, database string, tables []string) error {
	conn, err := connectDB(ctx, dsn, database)
	if err != nil {
		return err
	}
	defer closeDB(conn)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(6432, 1)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, sourceDDL); err != nil {
		return err
	}
	for _, name := range tables {
		var oid uint32
		var kind, persistence string
		var partition, inherited bool
		err = tx.QueryRow(ctx, `SELECT c.oid, c.relkind::text, c.relpersistence::text, c.relispartition,
   EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
   FROM pg_class c WHERE c.oid=to_regclass($1)`, name).Scan(&oid, &kind, &persistence, &partition, &inherited)
		if err != nil {
			return fmt.Errorf("audit table %s: %w", name, err)
		}
		if kind != "r" || persistence != "p" || partition || inherited {
			return fmt.Errorf("audit table %s must be an ordinary, non-inherited table", name)
		}
		ident := pgx.Identifier(strings.Split(name, ".")).Sanitize()
		for trigger, function := range map[string]string{"dbmesh_audit_changes": "capture_change", "dbmesh_audit_truncate": "audit_reject_truncate"} {
			var exists bool
			if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=$1 AND tgname=$2)", oid, trigger).Scan(&exists); err != nil {
				return err
			}
			if exists {
				var valid bool
				triggerType := 29 // AFTER ROW INSERT/UPDATE/DELETE
				if function == "audit_reject_truncate" {
					triggerType = 34
				} // BEFORE STATEMENT TRUNCATE
				if err = tx.QueryRow(ctx, `SELECT t.tgfoid=to_regprocedure($3) AND t.tgenabled IN ('O','A')
     AND t.tgtype=$4 AND t.tgqual IS NULL AND t.tgnargs=0 AND NOT t.tgisinternal
     FROM pg_trigger t WHERE t.tgrelid=$1 AND t.tgname=$2`, oid, trigger, "dbmesh."+function+"()", triggerType).Scan(&valid); err != nil {
					return err
				}
				if !valid {
					return fmt.Errorf("audit trigger %s on %s is disabled or incompatible", trigger, name)
				}
				continue
			}
			clause := "AFTER INSERT OR UPDATE OR DELETE ON " + ident + " FOR EACH ROW"
			if function == "audit_reject_truncate" {
				clause = "BEFORE TRUNCATE ON " + ident + " FOR EACH STATEMENT"
			}
			if _, err = tx.Exec(ctx, "CREATE TRIGGER "+trigger+" "+clause+" EXECUTE FUNCTION dbmesh."+function+"()"); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

// SetContext runs only on the session's private primary connection. Session
// scope avoids injecting BEGIN/COMMIT around user SQL. Renew before EACH primary
// message, even without request metadata, because ROLLBACK can restore old GUCs.
func SetContext(ctx context.Context, conn *pgconn.PgConn, tables, sinks []string, metadata *Context) error {
	values := map[string]any{"tables": tables, "sinks": sinks}
	if metadata != nil {
		values["user_id"], values["request_id"], values["service"] = metadata.UserID, metadata.RequestID, metadata.Service
	}
	data, err := json.Marshal(values)
	if err != nil {
		return err
	}
	result := conn.ExecParams(ctx, "SELECT pg_catalog.set_config('dbmesh.context', $1, false)", [][]byte{data}, nil, nil, nil).Read()
	return result.Err
}

// RowEvent is a committed row change. It is deliberately separate from the
// existing statement execution Event, which can describe failed/read queries.
type RowEvent struct {
	ID                           string
	DB, Schema, Table, Operation string
	UserID, RequestID, Service   *string
	Previous, New                json.RawMessage
	Created                      time.Time
}

// RowSink deliveries are at-least-once: implementations must deduplicate ID and
// return success only after durable acceptance. A queue sink can implement this.
type RowSink interface {
	Name() string
	Deliver(context.Context, RowEvent) error
	Close()
}

type PostgresSink struct {
	dsn  string
	conn *pgx.Conn
}

func NewPostgresSink(dsn string) *PostgresSink { return &PostgresSink{dsn: dsn} }
func (*PostgresSink) Name() string             { return "postgres" }
func (s *PostgresSink) Close() {
	if s.conn != nil {
		closeDB(s.conn)
		s.conn = nil
	}
}
func (s *PostgresSink) Deliver(ctx context.Context, e RowEvent) error {
	if s.conn == nil || s.conn.IsClosed() {
		conn, err := connectDB(ctx, s.dsn, "")
		if err != nil {
			return err
		}
		s.conn = conn
		// Serialize schema setup across database workers / DBMesh instances.
		tx, err := conn.Begin(ctx)
		if err == nil {
			_, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(6432, 2)")
			if err == nil {
				_, err = tx.Exec(ctx, destinationDDL)
			}
			if err == nil {
				err = tx.Commit(ctx)
			} else {
				_ = tx.Rollback(ctx)
			}
		}
		if err != nil {
			s.Close()
			return err
		}
	}
	_, err := s.conn.Exec(ctx, `INSERT INTO public.audit_events
  (event_id,db,"schema","table",operation,audit_user_id,audit_request_id,audit_service,previous_value,new_value,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(event_id) DO NOTHING`,
		e.ID, e.DB, e.Schema, e.Table, e.Operation, e.UserID, e.RequestID, e.Service, e.Previous, e.New, e.Created)
	if err != nil {
		s.Close()
	}
	return err
}
