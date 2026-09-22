package router

import (
	pgquery "github.com/pganalyze/pg_query_go/v6"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Classify inspects every statement and nested expression in a Simple Query
// message. Only explicitly supported read syntax may reach a replica.
// This is syntax analysis, not catalog resolution: views, operators and casts
// may hide user-defined behavior. See the documented demo assumptions.
func Classify(sql string) Decision {
	tree, err := pgquery.Parse(sql)
	if err != nil {
		return Decision{Target: Primary, Reason: "parse error; fail safe", SessionSticky: true, Operation: "unknown"}
	}
	if len(tree.Stmts) == 0 {
		return Decision{Target: Primary, Reason: "empty query", Operation: "empty"}
	}

	decision := Decision{Target: Replica, Reason: "read-only SELECT"}
	decision.Operation = "multi"
	if len(tree.Stmts) == 1 {
		decision.Operation = statementOperation(tree.Stmts[0].Stmt)
	}
	for _, raw := range tree.Stmts {
		d := classifyStatement(raw.Stmt)
		if d.Target == Primary && decision.Target != Primary {
			decision.Target, decision.Reason = Primary, d.Reason
		}
		decision.SessionSticky = decision.SessionSticky || d.SessionSticky
		// Retain the last transaction boundary, not just the presence of both.
		// Execution-time state always comes from PostgreSQL's ReadyForQuery.
		if d.BeginTx || d.EndTx {
			decision.BeginTx, decision.EndTx = d.BeginTx, d.EndTx
		}
	}
	return decision
}

// Operations lists every value Decision.Operation can take: statementOperation's results
// plus Classify's own "multi", "unknown" and "empty". Callers that need to pre-register
// per-operation state (such as Prometheus label values, so rate()/increase() has a
// baseline before an operation is first seen) should range over this instead of keeping
// a second copy, which can silently drift if a case is added to statementOperation below
// without updating it here too.
var Operations = []string{"select", "insert", "update", "delete", "merge", "transaction", "other", "multi", "unknown", "empty"}

func statementOperation(node *pgquery.Node) string {
	switch {
	case node.GetSelectStmt() != nil:
		return "select"
	case node.GetInsertStmt() != nil:
		return "insert"
	case node.GetUpdateStmt() != nil:
		return "update"
	case node.GetDeleteStmt() != nil:
		return "delete"
	case node.GetMergeStmt() != nil:
		return "merge"
	case node.GetTransactionStmt() != nil:
		return "transaction"
	default:
		return "other"
	}
}

func classifyStatement(node *pgquery.Node) Decision {
	if tx := node.GetTransactionStmt(); tx != nil {
		d := Decision{Target: Primary, Reason: "transaction control"}
		switch tx.Kind {
		case pgquery.TransactionStmtKind_TRANS_STMT_BEGIN, pgquery.TransactionStmtKind_TRANS_STMT_START:
			d.BeginTx = true
		case pgquery.TransactionStmtKind_TRANS_STMT_COMMIT, pgquery.TransactionStmtKind_TRANS_STMT_ROLLBACK:
			d.BeginTx, d.EndTx = tx.Chain, !tx.Chain
		case pgquery.TransactionStmtKind_TRANS_STMT_PREPARE:
			d.EndTx = true
		}
		return d
	}

	d := Decision{Target: Replica, Reason: "read-only SELECT"}
	inspectRead(node.ProtoReflect(), &d)
	return d
}

func requirePrimary(d *Decision, reason string, sticky bool) {
	if d.Target != Primary {
		d.Target, d.Reason = Primary, reason
	}
	d.SessionSticky = d.SessionSticky || sticky
}

// Walk protobuf messages rather than selected AST fields so that subqueries,
// CTE bodies, expression arguments and future populated fields are inspected.
// Unknown message types fail closed.
func inspectRead(m protoreflect.Message, d *Decision) {
	switch n := m.Interface().(type) {
	case *pgquery.SelectStmt:
		if n.IntoClause != nil {
			requirePrimary(d, "SELECT INTO", true)
		}
		if len(n.LockingClause) > 0 {
			requirePrimary(d, "locking SELECT", false)
		}
	case *pgquery.InsertStmt, *pgquery.UpdateStmt, *pgquery.DeleteStmt, *pgquery.MergeStmt:
		requirePrimary(d, "write statement", false)
		// A write may also contain a function that changes session state.
	case *pgquery.FuncCall:
		if !isSafeCatalogFunction(n) {
			requirePrimary(d, "function call; effects unknown", true)
		}
	case *pgquery.VariableSetStmt, *pgquery.DiscardStmt,
		*pgquery.ListenStmt, *pgquery.UnlistenStmt,
		*pgquery.PrepareStmt, *pgquery.DeallocateStmt, *pgquery.DeclareCursorStmt:
		requirePrimary(d, "session state statement", true)
	default:
		switch m.Descriptor().Name() {
		case "Node", "ResTarget", "ColumnRef", "RangeVar", "A_Star",
			"A_Const", "Integer", "Float", "Boolean", "String", "BitString",
			"List", "IntList", "OidList", "Alias",
			"A_Expr", "BoolExpr", "NullTest", "BooleanTest",
			"SortBy", "JoinExpr", "RangeSubselect", "SubLink",
			"WithClause", "CommonTableExpr", "TypeCast", "TypeName",
			"CaseExpr", "CaseWhen", "CoalesceExpr", "MinMaxExpr",
			"RowExpr", "A_ArrayExpr", "A_Indirection", "A_Indices",
			"CollateClause", "GroupingSet", "WindowDef", "LockingClause":
			// Structural nodes and supported expressions; inspect children.
		default:
			requirePrimary(d, "unsupported AST node; fail safe", true)
		}
	}
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		if fd.Message() == nil {
			return true
		}
		if fd.IsList() {
			list := v.List()
			for i := 0; i < list.Len(); i++ {
				inspectRead(list.Get(i).Message(), d)
			}
		} else {
			inspectRead(v.Message(), d)
		}
		return true
	})
}

// Keep this list narrow: these explicitly qualified catalog functions support
// psql's database listing. Arguments still pass through inspectRead. Like other
// supported expressions, this relies on the documented demo assumptions about
// user-defined types/casts; it does not perform catalog or overload resolution.
func isSafeCatalogFunction(n *pgquery.FuncCall) bool {
	if len(n.Funcname) != 2 {
		return false
	}
	schema := n.Funcname[0].GetString_()
	name := n.Funcname[1].GetString_()
	if schema == nil || name == nil || schema.Sval != "pg_catalog" {
		return false
	}
	switch name.Sval {
	case "pg_get_userbyid", "pg_encoding_to_char", "array_length", "array_to_string":
		return true
	default:
		return false
	}
}
