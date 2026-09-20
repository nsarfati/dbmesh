package router

import "testing"

func TestClassify(t *testing.T) {
	tests := []struct {
		name   string
		sql    string
		target Target
	}{
		{"select", "SELECT * FROM users", Replica},
		{"insert", "INSERT INTO users(name) VALUES ('nico')", Primary},
		{"update", "UPDATE users SET name='nico'", Primary},
		{"delete", "DELETE FROM users", Primary},
		{"locking select", "SELECT * FROM users FOR UPDATE", Primary},
		{"begin", "BEGIN", Primary},
		{"set", "SET search_path = app", Primary},
		{"unknown fails safe", "CALL do_something()", Primary},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Classify(tt.sql)
			if got.Target != tt.target {
				t.Fatalf("target=%v want=%v (%s)", got.Target, tt.target, got.Reason)
			}
		})
	}
}

func TestTransactionPinsReadsToPrimary(t *testing.T) {
	got := Route("SELECT * FROM users", SessionState{InTransaction: true})
	if got.Target != Primary {
		t.Fatalf("target=%v want primary", got.Target)
	}
}

func TestASTClassification(t *testing.T) {
	for _, tt := range []struct {
		sql    string
		target Target
	}{
		{"/* UPDATE users */ SELECT * FROM users", Replica},
		{"SELECT 'FOR UPDATE; DELETE FROM users' AS text", Replica},
		{"SELECT $$SET search_path = x;$$", Replica},
		{"SELECT * FROM users WHERE id = 1 ORDER BY id LIMIT 2", Replica},
		{"SELECT 1; SELECT 2", Replica},
		{"WITH x AS (SELECT * FROM users) SELECT * FROM x", Replica},
		{"SELECT * FROM (SELECT * FROM users) AS x", Replica},
		{"SELECT 1 UNION ALL SELECT 2", Replica},
		{"SELECT * FROM users FOR NO KEY UPDATE", Primary},
		{"SELECT * FROM users FOR SHARE", Primary},
		{"SELECT * FROM users FOR KEY SHARE", Primary},
		{"SELECT * FROM (SELECT * FROM users FOR UPDATE) AS x", Primary},
		{"WITH x AS (SELECT * FROM users FOR SHARE) SELECT * FROM x", Primary},
		{"WITH x AS (SELECT 1) UPDATE users SET plan = 'pro'", Primary},
		{"WITH x AS (UPDATE users SET plan = 'pro' RETURNING *) SELECT * FROM x", Primary},
		{"SELECT 1; DELETE FROM users", Primary},
		{"DELETE FROM users; SELECT 1", Primary},
		{"SELECT 1; nonsense", Primary},
		{"MERGE INTO users u USING users s ON u.id=s.id WHEN MATCHED THEN UPDATE SET plan='pro'", Primary},
		{"SELECT * INTO new_users FROM users", Primary},
		{"SELECT nextval('users_id_seq')", Primary},
		{"SELECT count(*) FROM users", Primary},
		{"SELECT * FROM users WHERE id = my_function()", Primary},
		{"SELECT 1 UNION SELECT my_function()", Primary},
		{"SELECT * FROM users WHERE EXISTS (SELECT my_function())", Primary},
		{"EXPLAIN ANALYZE DELETE FROM users", Primary},
		{"SHOW search_path", Primary},
		{"TABLE users", Replica},
		{"", Primary},
		{"; -- only a comment", Primary},
		{"SELEC 1", Primary},
	} {
		t.Run(tt.sql, func(t *testing.T) {
			d := Classify(tt.sql)
			if d.Target != tt.target {
				t.Fatalf("%+v; want target %v", d, tt.target)
			}
		})
	}
}

func TestASTSessionAndTransactionFlags(t *testing.T) {
	for _, tt := range []struct {
		sql                string
		begin, end, sticky bool
	}{
		{"BEGIN", true, false, false},
		{"START TRANSACTION READ ONLY", true, false, false},
		{"COMMIT", false, true, false},
		{"ROLLBACK", false, true, false},
		{"END", false, true, false},
		{"ROLLBACK TO SAVEPOINT x", false, false, false},
		{"SAVEPOINT x", false, false, false},
		{"RELEASE SAVEPOINT x", false, false, false},
		{"COMMIT AND CHAIN", true, false, false},
		{"ROLLBACK AND CHAIN", true, false, false},
		{"BEGIN; COMMIT", false, true, false},
		{"COMMIT; BEGIN", true, false, false},
		{"BEGIN; COMMIT; BEGIN", true, false, false},
		{"SET search_path = public", false, false, true},
		{"RESET ALL", false, false, true},
		{"SELECT 1; SET application_name = 'test'; SELECT 2", false, false, true},
		{"SET application_name = 'test'; BEGIN; COMMIT", false, true, true},
		{"SELECT set_config('application_name', 'test', false)", false, false, true},
		{"LISTEN changes", false, false, true},
		{"PREPARE x AS SELECT 1", false, false, true},
	} {
		t.Run(tt.sql, func(t *testing.T) {
			d := Classify(tt.sql)
			if d.Target != Primary || d.BeginTx != tt.begin || d.EndTx != tt.end || d.SessionSticky != tt.sticky {
				t.Fatalf("got %+v; want primary begin=%v end=%v sticky=%v", d, tt.begin, tt.end, tt.sticky)
			}
		})
	}
}

func TestStickySessionPinsReads(t *testing.T) {
	d := Route("SELECT 1", SessionState{StickyPrimary: true})
	if d.Target != Primary {
		t.Fatalf("got %+v; want primary", d)
	}
}
