package router

type Target int

const (
	Primary Target = iota
	Replica
)

func (t Target) String() string {
	switch t {
	case Replica:
		return "replica"
	default:
		return "primary"
	}
}

type Decision struct {
	Target        Target
	Reason        string
	BeginTx       bool
	EndTx         bool
	SessionSticky bool
}

type SessionState struct {
	InTransaction     bool
	TransactionFailed bool
	StickyPrimary     bool
}

func Route(sql string, state SessionState) Decision {
	if state.InTransaction {
		d := Classify(sql)
		d.Target = Primary
		d.Reason = "transaction pinned to primary"
		return d
	}

	if state.StickyPrimary {
		d := Classify(sql)
		d.Target = Primary
		d.Reason = "session pinned to primary"
		return d
	}

	return Classify(sql)
}
