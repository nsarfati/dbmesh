package config

import (
	"bytes"
	"fmt"
	"net/url"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the validated runtime configuration.
type Config struct {
	ListenAddr string
	// Databases is keyed by the database name clients request; the same name is
	// used upstream.
	Databases map[string]Database
	Audit     Audit
}

// Database holds the upstream connections DBMesh uses for one database.
type Database struct {
	WriterURL    string
	ReaderURLs   []string
	ReaderPolicy ReaderPolicy
}

// Audit configures row auditing. Sinks is empty when auditing is disabled.
type Audit struct {
	Sinks           []string
	DatabaseURL     string
	Retention       time.Duration // zero keeps delivered events forever
	CleanupInterval time.Duration
	CleanupBatch    int
}

// ReaderPolicy bounds the age and WAL distance of monitoring samples.
type ReaderPolicy struct {
	CheckInterval time.Duration
	CheckTimeout  time.Duration
	MaxLagBytes   int64
	StatusMaxAge  time.Duration
}

func DefaultReaderPolicy() ReaderPolicy {
	return ReaderPolicy{
		CheckInterval: time.Second,
		CheckTimeout:  500 * time.Millisecond,
		MaxLagBytes:   1024 * 1024,
		StatusMaxAge:  3 * time.Second,
	}
}

const (
	defaultListen          = ":6432"
	defaultRetention       = 7 * 24 * time.Hour
	defaultCleanupInterval = time.Minute
	defaultCleanupBatch    = 1000
)

// The file* types mirror config.yaml. Pointers distinguish "unset" from an
// explicit zero where zero is a valid value.
type fileConfig struct {
	Listen    string                  `yaml:"listen"`
	Databases map[string]fileDatabase `yaml:"databases"`
	Audit     fileAudit               `yaml:"audit"`
}

type fileDatabase struct {
	Writer fileWriter `yaml:"writer"`
	Reader fileReader `yaml:"reader"`
}

type fileWriter struct {
	User    string `yaml:"user"`
	Pwd     string `yaml:"pwd"`
	Host    string `yaml:"host"`
	SSLMode string `yaml:"sslmode"`
}

type fileReader struct {
	User          string   `yaml:"user"`
	Pwd           string   `yaml:"pwd"`
	Host          []string `yaml:"host"`
	SSLMode       string   `yaml:"sslmode"`
	CheckInterval duration `yaml:"check_interval"`
	CheckTimeout  duration `yaml:"check_timeout"`
	MaxLagBytes   *int64   `yaml:"max_lag_bytes"`
	StatusMaxAge  duration `yaml:"status_max_age"`
}

type fileAudit struct {
	Sinks    []string `yaml:"sinks"`
	Postgres struct {
		URL string `yaml:"url"`
	} `yaml:"postgres"`
	Retention       *duration `yaml:"retention"`
	CleanupInterval duration  `yaml:"cleanup_interval"`
	CleanupBatch    int       `yaml:"cleanup_batch"`
}

// duration accepts Go syntax ("500ms", "168h") and a bare 0, which yaml.v3
// would otherwise reject as an integer.
type duration time.Duration

func (d *duration) UnmarshalYAML(n *yaml.Node) error {
	if n.Value == "0" {
		*d = 0
		return nil
	}
	v, err := time.ParseDuration(n.Value)
	if err != nil {
		return fmt.Errorf("line %d: %q is not a valid duration (examples: 500ms, 30s, 168h)", n.Line, n.Value)
	}
	*d = duration(v)
	return nil
}

// Load reads and validates the YAML configuration at path.
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	cfg, err := Parse(data)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", path, err)
	}
	return cfg, nil
}

// Parse validates YAML configuration and applies defaults. Unknown keys are
// rejected so a misspelled option is never silently ignored.
func Parse(data []byte) (Config, error) {
	var raw fileConfig
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&raw); err != nil {
		return Config{}, fmt.Errorf("invalid config: %w", err)
	}

	cfg := Config{ListenAddr: raw.Listen, Databases: map[string]Database{}}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = defaultListen
	}
	if len(raw.Databases) == 0 {
		return Config{}, fmt.Errorf("databases: at least one database is required")
	}
	for name, db := range raw.Databases {
		parsed, err := db.build(name)
		if err != nil {
			return Config{}, err
		}
		cfg.Databases[name] = parsed
	}
	audit, err := raw.Audit.build()
	if err != nil {
		return Config{}, err
	}
	cfg.Audit = audit
	return cfg, nil
}

func (d fileDatabase) build(name string) (Database, error) {
	prefix := "databases." + name
	if name == "" {
		return Database{}, fmt.Errorf("databases: database name must not be empty")
	}
	if d.Writer.User == "" || d.Writer.Host == "" {
		return Database{}, fmt.Errorf("%s.writer: user and host are required", prefix)
	}
	out := Database{
		WriterURL:    postgresURL(d.Writer.User, d.Writer.Pwd, d.Writer.Host, name, d.Writer.SSLMode),
		ReaderPolicy: DefaultReaderPolicy(),
	}
	r := d.Reader
	if len(r.Host) == 0 {
		return out, nil
	}
	if r.User == "" {
		return Database{}, fmt.Errorf("%s.reader: user is required when hosts are set", prefix)
	}
	for _, host := range r.Host {
		if host == "" {
			return Database{}, fmt.Errorf("%s.reader.host: empty host", prefix)
		}
		out.ReaderURLs = append(out.ReaderURLs, postgresURL(r.User, r.Pwd, host, name, r.SSLMode))
	}
	for _, setting := range []struct {
		key   string
		set   duration
		value *time.Duration
	}{
		{"check_interval", r.CheckInterval, &out.ReaderPolicy.CheckInterval},
		{"check_timeout", r.CheckTimeout, &out.ReaderPolicy.CheckTimeout},
		{"status_max_age", r.StatusMaxAge, &out.ReaderPolicy.StatusMaxAge},
	} {
		if setting.set < 0 {
			return Database{}, fmt.Errorf("%s.reader.%s must be a positive duration", prefix, setting.key)
		}
		if setting.set > 0 {
			*setting.value = time.Duration(setting.set)
		}
	}
	if r.MaxLagBytes != nil {
		if *r.MaxLagBytes < 0 {
			return Database{}, fmt.Errorf("%s.reader.max_lag_bytes must be a non-negative integer", prefix)
		}
		out.ReaderPolicy.MaxLagBytes = *r.MaxLagBytes
	}
	return out, nil
}

func (a fileAudit) build() (Audit, error) {
	out := Audit{
		DatabaseURL:     a.Postgres.URL,
		Retention:       defaultRetention,
		CleanupInterval: defaultCleanupInterval,
		CleanupBatch:    defaultCleanupBatch,
	}
	for _, sink := range a.Sinks {
		if sink != "postgres" {
			return Audit{}, fmt.Errorf("audit.sinks: unsupported audit sink %q", sink)
		}
		if len(out.Sinks) != 0 {
			return Audit{}, fmt.Errorf("audit.sinks: duplicate audit sink %q", sink)
		}
		out.Sinks = append(out.Sinks, sink)
	}
	if len(out.Sinks) > 0 && out.DatabaseURL == "" {
		return Audit{}, fmt.Errorf("audit.postgres.url is required for the postgres sink")
	}
	if a.Retention != nil {
		if *a.Retention < 0 {
			return Audit{}, fmt.Errorf("audit.retention must not be negative")
		}
		out.Retention = time.Duration(*a.Retention)
	}
	if a.CleanupInterval < 0 {
		return Audit{}, fmt.Errorf("audit.cleanup_interval must be a positive duration")
	}
	if a.CleanupInterval > 0 {
		out.CleanupInterval = time.Duration(a.CleanupInterval)
	}
	if a.CleanupBatch < 0 {
		return Audit{}, fmt.Errorf("audit.cleanup_batch must be a positive integer")
	}
	if a.CleanupBatch > 0 {
		out.CleanupBatch = a.CleanupBatch
	}
	return out, nil
}

// postgresURL builds a DSN with credentials escaped, so passwords may contain
// any character. Sessions override the database with the client's choice, but
// monitoring connections use it as written.
func postgresURL(user, pwd, host, database, sslmode string) string {
	u := url.URL{Scheme: "postgres", User: url.UserPassword(user, pwd), Host: host, Path: "/" + database}
	if pwd == "" {
		u.User = url.User(user)
	}
	if sslmode != "" {
		u.RawQuery = url.Values{"sslmode": {sslmode}}.Encode()
	}
	return u.String()
}
