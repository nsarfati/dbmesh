import type { components, operations } from './schema'

// Named after what they are in the UI; the generated names collide with DOM types.
export type RowEvent = components['schemas']['Event']
export type FieldChange = components['schemas']['FieldChange']
export type EventPage = components['schemas']['EventPage']
export type Facets = components['schemas']['Facets']
export type Status = components['schemas']['Status']

/** Query parameters accepted by GET /api/events, minus paging. */
export type EventQuery = Omit<NonNullable<operations['list_events_api_events_get']['parameters']['query']>, 'limit' | 'cursor'>

// Explorer
export type TableList = components['schemas']['TableList']
export type TableRef = components['schemas']['TableRef']
export type TableOut = components['schemas']['TableOut']
export type ColumnOut = components['schemas']['ColumnOut']
export type RowsOut = components['schemas']['RowsOut']
export type RouteOut = components['schemas']['RouteOut']
export type ChangeIn = components['schemas']['ChangeIn']
type Required_ = 'schema' | 'table' | 'operation' | 'user_id' | 'key' | 'values'
/** A change request: the generated type lists every defaulted field as required, but the API fills them in. */
export type ChangeBody = Pick<ChangeIn, Required_> & Partial<Omit<ChangeIn, Required_>>
export type ChangeOut = components['schemas']['ChangeOut']
export type PreviewOut = components['schemas']['PreviewOut']
export type StatementOut = components['schemas']['StatementOut']
export type AuditOut = components['schemas']['AuditOut']
export type ReplicationOut = components['schemas']['ReplicationOut']
export type ReaderOut = components['schemas']['ReaderOut']
export type Row = Record<string, unknown>
