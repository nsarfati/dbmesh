CREATE SCHEMA IF NOT EXISTS dbmesh;
CREATE TABLE IF NOT EXISTS dbmesh.audit_outbox (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 db text NOT NULL,
 "schema" text NOT NULL,
 "table" text NOT NULL,
 operation text NOT NULL,
 audit_user_id text,
 audit_request_id text,
 audit_service text,
 previous_value jsonb,
 new_value jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS dbmesh.audit_delivery (
 event_id uuid NOT NULL REFERENCES dbmesh.audit_outbox(event_id),
 sink text NOT NULL,
 delivered_at timestamptz,
 PRIMARY KEY (event_id, sink)
);
CREATE INDEX IF NOT EXISTS audit_delivery_pending ON dbmesh.audit_delivery(sink, event_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_outbox_created ON dbmesh.audit_outbox(created_at);
-- Last delivery outcome per sink; pending counts are derived from audit_delivery.
CREATE TABLE IF NOT EXISTS dbmesh.audit_sink_status (
 sink text PRIMARY KEY,
 last_success_at timestamptz,
 last_error text,
 last_error_at timestamptz
);
CREATE OR REPLACE VIEW dbmesh.audit_delivery_status AS
WITH pending AS (
 SELECT d.sink, count(*) AS pending, min(o.created_at) AS oldest_pending_at
 FROM dbmesh.audit_delivery d JOIN dbmesh.audit_outbox o USING (event_id)
 WHERE d.delivered_at IS NULL GROUP BY d.sink
)
SELECT sink, coalesce(p.pending, 0) AS pending, p.oldest_pending_at,
 clock_timestamp() - p.oldest_pending_at AS oldest_pending_age,
 s.last_success_at, s.last_error, s.last_error_at
FROM pending p FULL JOIN dbmesh.audit_sink_status s USING (sink);
CREATE OR REPLACE FUNCTION dbmesh.capture_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
 ctx jsonb;
 event uuid;
BEGIN
 ctx := nullif(current_setting('dbmesh.context', true), '')::jsonb;
 IF ctx IS NULL OR NOT (ctx->'tables' @> to_jsonb(ARRAY[TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME])) THEN
  RETURN NULL;
 END IF;
 INSERT INTO dbmesh.audit_outbox(db, "schema", "table", operation,
   audit_user_id, audit_request_id, audit_service, previous_value, new_value)
 VALUES (current_database(), TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP,
   ctx->>'user_id', ctx->>'request_id', ctx->>'service',
   CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
   CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END)
 RETURNING event_id INTO event;
 INSERT INTO dbmesh.audit_delivery(event_id, sink)
 SELECT event, jsonb_array_elements_text(ctx->'sinks');
 PERFORM pg_notify('dbmesh_audit_pending', '');
 RETURN NULL;
END;
$$;
-- TRUNCATE has no OLD rows. Reject it when selected instead of losing history.
CREATE OR REPLACE FUNCTION dbmesh.audit_reject_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE ctx jsonb;
BEGIN
 ctx := nullif(current_setting('dbmesh.context', true), '')::jsonb;
 IF ctx->'tables' @> to_jsonb(ARRAY[TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME]) THEN
  RAISE EXCEPTION 'TRUNCATE is unsupported for selected audit tables' USING ERRCODE = '0A000';
 END IF;
 RETURN NULL;
END;
$$;
