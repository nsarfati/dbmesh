package audit

import "testing"

func TestStartupTables(t *testing.T) {
	for _, value := range []string{"-c dbmesh.audit_tables=public.users,public.accounts", "-cdbmesh.audit_tables=public.users,public.accounts"} {
		tables, err := StartupTables(value)
		if err != nil || len(tables) != 2 || tables[0] != "public.users" {
			t.Fatalf("%v %v", tables, err)
		}
	}
	for _, value := range []string{"", "users", "public.users;drop", "dbmesh.audit_outbox", "pg_catalog.pg_class", "public.Users", "public.users,"} {
		if _, err := ParseTables(value); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	if _, err := StartupTables("-c dbmesh.audit_tables=public.users -c dbmesh.audit_tables=public.accounts"); err == nil {
		t.Fatal("accepted duplicate option")
	}
}
