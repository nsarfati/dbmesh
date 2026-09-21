// Package audit defines DBMesh's opt-in query metadata and audit events.
package audit

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaxHeaderBytes = 2048

type Context struct {
	UserID    string `json:"user_id"`
	RequestID string `json:"request_id"`
	Service   string `json:"service,omitempty"`
}

// Extract accepts a single leading, versioned header. It never scans SQL
// literals or ordinary comments for metadata. The ASCII header is replaced by
// spaces so PostgreSQL error positions still refer to the original query.
func Extract(sql string) (string, *Context, error) {
	start := len(sql) - len(strings.TrimLeft(sql, " \t\r\n\f\v"))
	if !strings.HasPrefix(sql[start:], "/*dbmesh:") {
		return sql, nil, nil
	}
	fail := func() (string, *Context, error) {
		return "", nil, fmt.Errorf("invalid DBMesh audit header; expected v1 with user_id and request_id")
	}
	end := strings.Index(sql[start:], "*/")
	if end < 0 || end+2 > MaxHeaderBytes || !strings.HasPrefix(sql[start:], "/*dbmesh:v1:") {
		return fail()
	}
	end += start + 2
	raw := sql[start+len("/*dbmesh:v1:") : end-2]
	// Reject whitespace/padding rather than accepting alternate encodings.
	for _, c := range raw {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return fail()
		}
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil || !utf8.Valid(data) {
		return fail()
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return fail()
	}
	fields := make(map[string]string)
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return fail()
		}
		name, ok := token.(string)
		if !ok || (name != "user_id" && name != "request_id" && name != "service") {
			return fail()
		}
		if _, duplicate := fields[name]; duplicate {
			return fail()
		}
		token, err = d.Token()
		value, ok := token.(string)
		if err != nil || !ok || len(value) > 256 {
			return fail()
		}
		for _, c := range value {
			if unicode.IsControl(c) {
				return fail()
			}
		}
		fields[name] = value
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') {
		return fail()
	}
	if _, err := d.Token(); err != io.EOF {
		return fail()
	}
	if strings.TrimSpace(fields["user_id"]) == "" || strings.TrimSpace(fields["request_id"]) == "" {
		return fail()
	}
	if strings.HasPrefix(strings.TrimLeft(sql[end:], " \t\r\n\f\v"), "/*dbmesh:") {
		return fail()
	}
	context := &Context{UserID: fields["user_id"], RequestID: fields["request_id"], Service: fields["service"]}
	return sql[:start] + strings.Repeat(" ", end-start) + sql[end:], context, nil
}
