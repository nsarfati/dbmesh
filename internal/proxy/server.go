package proxy

import (
	"context"
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

	"dbmesh/internal/config"
	"dbmesh/internal/router"
	"dbmesh/internal/upstream"
)

type Server struct {
	cfg    config.Config
	logger *slog.Logger
}

func NewServer(cfg config.Config, logger *slog.Logger) *Server {
	return &Server{cfg: cfg, logger: logger}
}

func (s *Server) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.cfg.ListenAddr)
	if err != nil {
		return err
	}
	defer ln.Close()

	s.logger.Info("dbmesh listening", "addr", s.cfg.ListenAddr, "readers", len(s.cfg.ReaderURLs))

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
	upstreamSession, err := upstream.Connect(ctx, s.cfg.WriterURL, s.cfg.ReaderURLs, database)
	if err != nil {
		sendError(backend, err)
		_ = backend.Flush()
		return err
	}
	defer upstreamSession.Close(context.Background())

	// MVP auth model: DBMesh terminates client auth and uses configured
	// credentials for upstream PostgreSQL connections.
	backend.Send(&pgproto3.AuthenticationOk{})
	backend.Send(&pgproto3.ParameterStatus{Name: "server_version", Value: "16.0"})
	backend.Send(&pgproto3.ParameterStatus{Name: "server_encoding", Value: "UTF8"})
	backend.Send(&pgproto3.ParameterStatus{Name: "client_encoding", Value: "UTF8"})
	backend.Send(&pgproto3.ParameterStatus{Name: "DateStyle", Value: "ISO, MDY"})
	backend.Send(&pgproto3.ParameterStatus{Name: "integer_datetimes", Value: "on"})
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

	for {
		msg, err := backend.Receive()
		if err != nil {
			return err
		}

		switch msg := msg.(type) {
		case *pgproto3.Query:
			if err := s.handleQuery(ctx, backend, upstreamSession, &state, msg.String); err != nil {
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
	sql string,
) error {
	if strings.TrimSpace(sql) == "" {
		backend.Send(&pgproto3.EmptyQueryResponse{})
		backend.Send(&pgproto3.ReadyForQuery{TxStatus: txStatus(*state)})
		return backend.Flush()
	}

	decision := router.Route(sql, *state)
	target := ups.Writer()
	targetName := "primary"
	if decision.Target == router.Replica {
		target = ups.Reader()
		targetName = "replica"
	}

	started := time.Now()
	results, execErr := target.Exec(ctx, sql).ReadAll()
	elapsed := time.Since(started)

	// The upstream status accounts for errors, multiple transaction boundaries,
	// ROLLBACK TO and COMMIT AND CHAIN without guessing from the SQL.
	status := target.TxStatus()
	state.InTransaction = status == 'T' || status == 'E'
	state.TransactionFailed = status == 'E'
	// Pin conservatively even on errors: an earlier statement/function may
	// already have changed session state.
	state.StickyPrimary = state.StickyPrimary || decision.SessionSticky

	backend.Send((*pgproto3.NoticeResponse)(&pgproto3.ErrorResponse{
		Severity: "NOTICE",
		Code:     "00000",
		Message:  fmt.Sprintf("dbmesh -> %s (%s, %s)", targetName, decision.Reason, elapsed.Round(time.Microsecond)),
	}))

	s.logger.Info("query routed",
		"target", targetName,
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
