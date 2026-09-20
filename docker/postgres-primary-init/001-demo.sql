CREATE TABLE IF NOT EXISTS users (
    id bigserial PRIMARY KEY,
    name text NOT NULL,
    plan text NOT NULL DEFAULT 'free'
);

INSERT INTO users(name, plan)
VALUES ('Ada', 'pro'), ('Grace', 'free'), ('Linus', 'pro')
ON CONFLICT DO NOTHING;
