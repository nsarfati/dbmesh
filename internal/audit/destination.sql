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
