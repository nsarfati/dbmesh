package audit

import (
	"fmt"
	"regexp"
	"strings"
)

var tablePattern = regexp.MustCompile(`^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$`)

// ParseTables deliberately accepts only unquoted, schema-qualified identifiers.
func ParseTables(value string) ([]string, error) {
	if value == "" || len(value) > 4096 {
		return nil, fmt.Errorf("audit requires schema.table names (max 4096 bytes)")
	}
	var tables []string
	seen := map[string]bool{}
	for _, name := range strings.Split(value, ",") {
		parts := strings.Split(name, ".")
		if !tablePattern.MatchString(name) || len(parts[0]) > 63 || len(parts[1]) > 63 || parts[0] == "dbmesh" || strings.HasPrefix(parts[0], "pg_") || parts[0] == "information_schema" {
			return nil, fmt.Errorf("unsupported audit table %q; use ordinary schema.table names", name)
		}
		if !seen[name] {
			tables = append(tables, name)
			seen[name] = true
		}
	}
	return tables, nil
}

// StartupTables consumes DBMesh's reserved option without forwarding it upstream.
func StartupTables(options string) ([]string, error) {
	fields := strings.Fields(options)
	var tables []string
	for i := 0; i < len(fields); i++ {
		field := fields[i]
		if field == "-c" && i+1 < len(fields) {
			i++
			field = fields[i]
		} else {
			field = strings.TrimPrefix(field, "-c")
		}
		if strings.HasPrefix(field, "dbmesh.audit_tables=") {
			if tables != nil {
				return nil, fmt.Errorf("duplicate dbmesh.audit_tables option")
			}
			var err error
			tables, err = ParseTables(strings.TrimPrefix(field, "dbmesh.audit_tables="))
			if err != nil {
				return nil, err
			}
		} else if strings.Contains(field, "dbmesh.audit") {
			return nil, fmt.Errorf("invalid DBMesh audit startup option")
		}
	}
	return tables, nil
}
