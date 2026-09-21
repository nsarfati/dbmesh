package audit

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func header(data string) string {
	return "/*dbmesh:v1:" + base64.RawURLEncoding.EncodeToString([]byte(data)) + "*/"
}

func TestExtractContext(t *testing.T) {
	raw := `{"user_id":"812 */ SELECT 'x'","request_id":"req-ñ","service":"billing"}`
	prefix := header(raw)
	query := "  " + prefix + "\nSELECT '/*dbmesh:ordinary literal*/'"
	clean, metadata, err := Extract(query)
	if err != nil || metadata == nil || metadata.UserID != "812 */ SELECT 'x'" || metadata.RequestID != "req-ñ" {
		t.Fatalf("metadata=%+v err=%v", metadata, err)
	}
	want := strings.Repeat(" ", 2+len(prefix)) + "\nSELECT '/*dbmesh:ordinary literal*/'"
	if clean != want {
		t.Fatalf("clean=%q want=%q", clean, want)
	}
}

func TestOrdinarySQLIsUntouched(t *testing.T) {
	for _, query := range []string{"", "SELECT 1", "/* normal comment */ SELECT 1", "SELECT '/*dbmesh:v1:bad*/'", "-- hello\nSELECT 1"} {
		clean, metadata, err := Extract(query)
		if err != nil || metadata != nil || clean != query {
			t.Fatalf("%q: %q %+v %v", query, clean, metadata, err)
		}
	}
}

func TestRejectInvalidContext(t *testing.T) {
	for _, raw := range []string{
		`{}`, `null`, `[]`, `{"user_id":"812"}`, `{"user_id":" ","request_id":"x"}`,
		`{"user_id":812,"request_id":"x"}`, `{"user_id":"812","request_id":"x","unknown":"x"}`,
		`{"user_id":"812","request_id":"x","service":null}`,
		`{"user_id":"812","user_id":"813","request_id":"x"}`,
		`{"user_id":"812","request_id":"x"} {}`, `{"user_id":"812","request_id":"x\n"}`,
		`{"user_id":"` + strings.Repeat("x", 257) + `","request_id":"x"}`,
	} {
		if _, _, err := Extract(header(raw) + " SELECT 1"); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, query := range []string{
		"/*dbmesh:v2:e30*/ SELECT 1", "/*dbmesh:v1:bad!*/ SELECT 1", "/*dbmesh:v1:e30=*/ SELECT 1",
		"/*dbmesh:v1:unterminated", "/*dbmesh:v1:" + strings.Repeat("A", MaxHeaderBytes) + "*/ SELECT 1",
		header(`{"user_id":"x","request_id":"y"}`) + header(`{"user_id":"z","request_id":"w"}`) + " SELECT 1",
	} {
		if _, _, err := Extract(query); err == nil {
			t.Fatalf("accepted malformed header")
		}
	}
}

func TestLogSinkStructuredEvent(t *testing.T) {
	var out bytes.Buffer
	sink := LogSink{Logger: slog.New(slog.NewJSONHandler(&out, nil))}
	err := sink.Emit(context.Background(), Event{
		Time: time.Now(), QueryID: "q1", ConnectionID: "c1", Context: Context{UserID: "812", RequestID: "req-1", Service: "billing"},
		SQL: "SELECT 1", Target: "replica", Reader: 2, Outcome: "success", TxBefore: "I", TxAfter: "I", Rows: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(out.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["user_id"] != "812" || event["request_id"] != "req-1" || event["target"] != "replica" || event["reader"] != float64(2) {
		t.Fatalf("unexpected log: %s", out.String())
	}
}
