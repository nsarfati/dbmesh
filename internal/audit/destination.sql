CREATE TABLE IF NOT EXISTS public.audit_events (
 event_id uuid PRIMARY KEY,
 db text NOT NULL,
 "schema" text NOT NULL,
 "table" text NOT NULL,
 operation text NOT NULL,
 audit_user_id text,
 audit_request_id text,
 audit_service text,
 previous_value jsonb,
 new_value jsonb,
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_request ON public.audit_events(audit_request_id);
-- The dashboard lists events newest first and filters by table.
CREATE INDEX IF NOT EXISTS audit_events_created ON public.audit_events(created_at DESC, event_id DESC);
CREATE INDEX IF NOT EXISTS audit_events_table ON public.audit_events("schema", "table", created_at DESC);
