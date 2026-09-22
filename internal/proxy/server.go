package proxy

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	pgquery "github.com/pganalyze/pg_query_go/v6"

	"github.com/nsarfati/dbmesh/internal/audit"
	"github.com/nsarfati/dbmesh/internal/config"
	"github.com/nsarfati/dbmesh/internal/router"
	"github.com/nsarfati/dbmesh/internal/upstream"
)

type Server struct {
	cfg       config.Config
	logger    *slog.Logger
	auditSink audit.Sink
	databases map[string]*database
	metrics   *queryMetrics
}

// database is the runtime state of one configured database.
type database struct {
	cfg        config.Database
	monitor    *upstream.Monitor
	dispatcher *audit.Dispatcher // nil unless row auditing is enabled
}

func NewServer(cfg config.Config, logger *slog.Logger) *Server {
	s := &Server{cfg: cfg, logger: logger, auditSink: audit.LogSink{Logger: logger},
		databases: make(map[string]*database, len(cfg.Databases))}
	s.metrics = newQueryMetrics(cfg)
	for name, dbCfg := range cfg.Databases {
		if dbCfg.ReaderPolicy.CheckInterval == 0 {
			dbCfg.ReaderPolicy = config.DefaultReaderPolicy()
		}
		db := &database{cfg: dbCfg,
			monitor: upstream.NewMonitor(dbCfg.WriterURL, dbCfg.ReaderURLs, dbCfg.ReaderPolicy, logger.With("database", name))}
		if len(cfg.Audit.Sinks) > 0 {
			db.dispatcher = &audit.Dispatcher{WriterURL: dbCfg.WriterURL, Database: name, DestinationURL: cfg.Audit.DatabaseURL,
				Retention: cfg.Audit.Retention, CleanupInterval: cfg.Audit.CleanupInterval, CleanupBatch: cfg.Audit.CleanupBatch,
				Logger: logger, Wake: make(chan struct{}, 1)}
		}
		s.databases[name] = db
	}
	return s
}

func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.cfg.ListenAddr)
	if err != nil {
		return err
	}
	defer ln.Close()
	closeMetrics, err := s.startMetrics()
	if err != nil {
		return err
	}
	defer closeMetrics()
	var background sync.WaitGroup
	runCtx, stopBackground := context.WithCancel(ctx)
	defer func() { stopBackground(); background.Wait() }()
	readers := 0
	for _, db := range s.databases {
		readers += len(db.cfg.ReaderURLs)
		background.Add(1)
		go func() { defer background.Done(); db.monitor.Run(runCtx) }()
		if db.dispatcher != nil {
			background.Add(1)
			go func() { defer background.Done(); db.dispatcher.Run(runCtx) }()
		}
	}

	s.logger.Info("dbmesh listening", "addr", s.cfg.ListenAddr, "databases", len(s.databases), "readers", readers)

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	var wg sync.WaitGroup
	defer wg.Wait()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.handleClient(ctx, conn); err != nil && !errors.Is(err, io.EOF) {
				s.logger.Warn("client disconnected with error", "err", err)
			}
		}()
	}
}

func (s *Server) handleClient(ctx context.Context, conn net.Conn) error {
	defer conn.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stopClose()

	backend := pgproto3.NewBackend(conn, conn)
	startup, err := receiveStartup(backend, conn)
	if err != nil {
		return err
	}

	sm, ok := startup.(*pgproto3.StartupMessage)
	if !ok {
		return fmt.Errorf("unsupported startup message %T", startup)
	}

	database := sm.Parameters["database"]
	if database == "" {
		// PostgreSQL defaults the database to the requested user.
		database = sm.Parameters["user"]
	}
	db, ok := s.databases[database]
	if !ok {
		err := &pgconn.PgError{Severity: "FATAL", Code: "3D000", Message: fmt.Sprintf("database %q is not configured in DBMesh", database)}
		sendError(backend, err)
		_ = backend.Flush()
		return err
	}
	upstreamSession, err := upstream.Connect(ctx, db.cfg.WriterURL, db.cfg.ReaderURLs, database, db.monitor)
	if err != nil {
		sendError(backend, err)
		_ = backend.Flush()
		return err
	}
	defer upstreamSession.Close(context.Background())
	tables, err := audit.StartupTables(sm.Parameters["options"])
	if err == nil && len(tables) > 0 {
		if db.dispatcher == nil {
			err = fmt.Errorf("row auditing requires audit.sinks to include postgres in the DBMesh config")
		} else {
			prepareCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			err = audit.Prepare(prepareCtx, db.cfg.WriterURL, database, tables)
			cancel()
			if err == nil {
				select {
				case db.dispatcher.Wake <- struct{}{}:
				default:
				}
			}
		}
	}
	if err != nil {
		sendError(backend, &pgconn.PgError{Severity: "FATAL", Code: "22023", Message: err.Error()})
		_ = backend.Flush()
		return err
	}

	// MVP auth model: DBMesh terminates client auth and uses configured
	// credentials for upstream PostgreSQL connections.
	backend.Send(&pgproto3.AuthenticationOk{})
	// Clients such as psql choose catalog queries from this startup version.
	for _, name := range reportedParameters {
		backend.Send(&pgproto3.ParameterStatus{Name: name, Value: upstreamSession.Writer().ParameterStatus(name)})
	}
	backend.Send(&pgproto3.ParameterStatus{Name: "dbmesh_audit", Value: "comment-v1"})
	if len(tables) > 0 {
		backend.Send(&pgproto3.ParameterStatus{Name: "dbmesh_audit_tables", Value: strings.Join(tables, ",")})
	}
	backend.Send(&pgproto3.BackendKeyData{ProcessID: 1, SecretKey: 1})
	backend.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if err := backend.Flush(); err != nil {
		return err
	}

	clientID := sm.Parameters["application_name"]
	if clientID == "" {
		clientID = sm.Parameters["user"]
	}
	s.logger.Info("client connected", "client", clientID, "database", database)

	state := router.SessionState{}
	client := auditClient{connectionID: newID(), database: database, user: sm.Parameters["user"], addr: conn.RemoteAddr().String(), tables: tables}

	for {
		msg, err := backend.Receive()
		if err != nil {
			return err
		}

		switch msg := msg.(type) {
		case *pgproto3.Query:
			if err := s.handleQuery(ctx, backend, upstreamSession, &state, client, msg.String); err != nil {
				return err
			}

		case *pgproto3.Terminate:
			return nil

		default:
			sendProtocolError(backend, fmt.Sprintf("unsupported frontend message %T; MVP supports Simple Query Protocol only", msg))
			backend.Send(&pgproto3.ReadyForQuery{TxStatus: txStatus(state)})
			if err := backend.Flush(); err != nil {
				return err
			}
		}
	}
}

func (s *Server) handleQuery(
	ctx context.Context,
	backend *pgproto3.Backend,
	ups *upstream.Session,
	state *router.SessionState,
	client auditClient,
	sql string,
) error {
	sql, metadata, err := audit.Extract(sql)
	if err != nil {
		// Do not execute malformed metadata or log its untrusted payload.
		sendError(backend, &pgconn.PgError{Severity: "ERROR", Code: "22023", Message: err.Error()})
		backend.Send(&pgproto3.ReadyForQuery{TxStatus: txStatus(*state)})
		return backend.Flush()
	}
	if strings.TrimSpace(sql) == "" {
		backend.Send(&pgproto3.EmptyQueryResponse{})
		backend.Send(&pgproto3.ReadyForQuery{TxStatus: txStatus(*state)})
		return backend.Flush()
	}
	if len(client.tables) > 0 {
		tree, parseErr := pgquery.Parse(sql)
		if parseErr == nil && len(tree.Stmts) > 1 {
			sendProtocolError(backend, "row auditing supports one SQL statement per message; execute transaction commands separately")
			backend.Send(&pgproto3.ReadyForQuery{TxStatus: txStatus(*state)})
			return backend.Flush()
		}
	}

	decision := router.Route(sql, *state)
	target := ups.Writer()
	targetName := "primary"
	readerID := 0
	if decision.Target == router.Replica {
		var reason string
		target, readerID, reason = ups.Reader(ctx)
		if readerID > 0 {
			targetName = "replica"
			decision.Reason += fmt.Sprintf("; reader %d", readerID)
		} else {
			decision.Reason = reason
		}
	}

	started := time.Now()
	txBefore := string([]byte{target.TxStatus()})
	var results []*pgconn.Result
	var execErr error
	if len(client.tables) > 0 && targetName == "primary" && target.TxStatus() != 'E' {
		execErr = audit.SetContext(ctx, target, client.tables, s.cfg.Audit.Sinks, metadata)
	}
	if execErr == nil {
		queryStarted := time.Now()
		results, execErr = readAll(target.Exec(ctx, sql))
		s.metrics.observe(client.database, decision.Operation, targetName, readerID, time.Since(queryStarted), results, execErr)
	}
	elapsed := time.Since(started)

	// The upstream status accounts for errors, multiple transaction boundaries,
	// ROLLBACK TO and COMMIT AND CHAIN without guessing from the SQL.
	status := target.TxStatus()
	state.InTransaction = status == 'T' || status == 'E'
	state.TransactionFailed = status == 'E'
	// Pin conservatively even on errors: an earlier statement/function may
	// already have changed session state.
	state.StickyPrimary = state.StickyPrimary || decision.SessionSticky
	if metadata != nil {
		event := audit.Event{
			Time: started, QueryID: newID(), ConnectionID: client.connectionID,
			Context: *metadata, Database: client.database, ClientUser: client.user, ClientAddr: client.addr,
			SQL: strings.TrimSpace(sql), Target: targetName, Reader: readerID, Duration: elapsed,
			TxBefore: txBefore, TxAfter: string([]byte{status}), // Outcome/SQLState set below, unconditionally
		}
		// Commands/Rows reflect what was actually returned, independent of the outcome below.
		var resultErr error
		for _, result := range results {
			if result.Err != nil {
				resultErr = result.Err
				break
			}
			event.Commands = append(event.Commands, result.CommandTag.String())
			event.Rows += result.CommandTag.RowsAffected()
		}
		event.Outcome, event.SQLState = classifyOutcome(execErr, resultErr)
		if target.IsClosed() {
			event.TxAfter = "unknown"
		}
		if err := s.auditSink.Emit(ctx, event); err != nil {
			s.logger.Error("audit sink failed", "query_id", event.QueryID, "err", err)
		}
	}

	backend.Send((*pgproto3.NoticeResponse)(&pgproto3.ErrorResponse{
		Severity: "NOTICE",
		Code:     "00000",
		Message:  fmt.Sprintf("dbmesh -> %s (%s, %s)", targetName, decision.Reason, elapsed.Round(time.Microsecond)),
		Detail:   s.routeDetail(client.database, targetName, readerID, decision, elapsed),
	}))

	s.logger.Info("query routed",
		"target", targetName,
		"reader", readerID,
		"reason", decision.Reason,
		"duration", elapsed,
		"sql", oneLine(sql),
	)

	queryFailed := false
	for _, result := range results {
		if result.Err != nil {
			queryFailed = true
			sendError(backend, result.Err)
			break
		}

		if len(result.FieldDescriptions) > 0 {
			fields := make([]pgproto3.FieldDescription, 0, len(result.FieldDescriptions))
			for _, fd := range result.FieldDescriptions {
				fields = append(fields, pgproto3.FieldDescription{
					Name:                 []byte(fd.Name),
					TableOID:             fd.TableOID,
					TableAttributeNumber: fd.TableAttributeNumber,
					DataTypeOID:          fd.DataTypeOID,
					DataTypeSize:         fd.DataTypeSize,
					TypeModifier:         fd.TypeModifier,
					Format:               fd.Format,
				})
			}
			backend.Send(&pgproto3.RowDescription{Fields: fields})
		}

		for _, row := range result.Rows {
			backend.Send(&pgproto3.DataRow{Values: row})
		}

		backend.Send(&pgproto3.CommandComplete{CommandTag: []byte(result.CommandTag.String())})
	}

	if execErr != nil && !queryFailed {
		sendError(backend, execErr)
	}
	if execErr == nil && len(results) == 0 {
		backend.Send(&pgproto3.EmptyQueryResponse{})
	}

	backend.Send(&pgproto3.ReadyForQuery{TxStatus: txStatus(*state)})
	return backend.Flush()
}

// readAll drains a multi-result reader like MultiResultReader.ReadAll, but keeps
// each result's column descriptions even when it has no rows: pgconn only
// records them while reading rows, and clients need them to describe an empty
// result set.
func readAll(mrr *pgconn.MultiResultReader) ([]*pgconn.Result, error) {
	var results []*pgconn.Result
	for mrr.NextResult() {
		rr := mrr.ResultReader()
		fields := append([]pgconn.FieldDescription(nil), rr.FieldDescriptions()...)
		result := rr.Read()
		if len(result.FieldDescriptions) == 0 {
			result.FieldDescriptions = fields
		}
		results = append(results, result)
	}
	err := mrr.Close()
	return results, err
}

// reportedParameters are the settings PostgreSQL announces at startup that
// clients use to decode results: without TimeZone, IntervalStyle or
// standard_conforming_strings, drivers such as psycopg cannot read timestamps
// (and its C extension crashes). They come from the writer, so a client sees the
// same values it would get connecting directly.
var reportedParameters = []string{
	"server_version", "server_encoding", "client_encoding", "DateStyle", "IntervalStyle",
	"TimeZone", "integer_datetimes", "standard_conforming_strings",
}

// routeInfo is the machine-readable form of the route NOTICE, sent as its
// DETAIL so clients need not parse the human-readable message.
type routeInfo struct {
	Target     string  `json:"target"`
	Reader     int     `json:"reader,omitempty"`
	Reason     string  `json:"reason"`
	LagBytes   *uint64 `json:"lag_bytes,omitempty"` // last monitor sample of the serving reader
	DurationUS int64   `json:"duration_us"`
	Fallback   bool    `json:"fallback,omitempty"` // a read that could not use a reader
}

func (s *Server) routeDetail(database, target string, reader int, decision router.Decision, elapsed time.Duration) string {
	info := routeInfo{Target: target, Reader: reader, Reason: decision.Reason, DurationUS: elapsed.Microseconds(),
		Fallback: decision.Target == router.Replica && reader == 0}
	if db, ok := s.databases[database]; ok && reader > 0 {
		lag := db.monitor.Status(reader - 1).LagBytes
		info.LagBytes = &lag
	}
	data, err := json.Marshal(info)
	if err != nil {
		return ""
	}
	return string(data)
}

type auditClient struct {
	connectionID, database, user, addr string
	tables                             []string
}

func newID() string {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", id)
}

func receiveStartup(backend *pgproto3.Backend, conn net.Conn) (pgproto3.FrontendMessage, error) {
	for {
		msg, err := backend.ReceiveStartupMessage()
		if err != nil {
			return nil, err
		}

		switch msg.(type) {
		case *pgproto3.SSLRequest, *pgproto3.GSSEncRequest:
			// PostgreSQL protocol: a single 'N' rejects encryption and the
			// client retries with a regular StartupMessage.
			if _, err := conn.Write([]byte{'N'}); err != nil {
				return nil, err
			}
		default:
			return msg, nil
		}
	}
}

func txStatus(state router.SessionState) byte {
	if state.TransactionFailed {
		return 'E'
	}
	if state.InTransaction {
		return 'T'
	}
	return 'I'
}

func sendProtocolError(backend *pgproto3.Backend, message string) {
	backend.Send(&pgproto3.ErrorResponse{
		Severity: "ERROR",
		Code:     "0A000",
		Message:  message,
	})
}

func sendError(backend *pgproto3.Backend, err error) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		backend.Send(&pgproto3.ErrorResponse{
			Severity:       pgErr.Severity,
			Code:           pgErr.Code,
			Message:        pgErr.Message,
			Detail:         pgErr.Detail,
			Hint:           pgErr.Hint,
			Position:       pgErr.Position,
			InternalQuery:  pgErr.InternalQuery,
			Where:          pgErr.Where,
			SchemaName:     pgErr.SchemaName,
			TableName:      pgErr.TableName,
			ColumnName:     pgErr.ColumnName,
			DataTypeName:   pgErr.DataTypeName,
			ConstraintName: pgErr.ConstraintName,
		})
		return
	}

	backend.Send(&pgproto3.ErrorResponse{
		Severity: "ERROR",
		Code:     "XX000",
		Message:  err.Error(),
	})
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 180 {
		return s[:180] + "..."
	}
	return s
}
