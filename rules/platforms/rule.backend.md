<!-- Backend platform is ENABLED for this project (ironbee-dt-backend MCP server). -->

## Backend platform: runtime-agnostic verification

Verify backend services with the IronBee DevTools backend tools — language- and framework-independent.
Satisfy the verification by **any one of three evidence paths**: a real protocol call, server-log
inspection, or direct database inspection. Pick whichever fits the change.

### Evidence paths

- **Protocol call** — drive the affected endpoint and inspect the result: `request_http` (HTTP/1.1 +
  HTTP/2), `request_grpc`, `request_graphql`, `request_websocket-*`, or `request_replay`. A 4xx/5xx is a
  normal result, not a transport error. Cookie jar (`request_*-cookies`) and default headers/metadata
  (`request_set-default-headers` / `request_set-default-metadata`) persist across calls.
- **Log evidence** — `log_register-source` (file / docker / kubernetes) → `log_read` (supports `tail` /
  `since` / `until` / `pattern` / `level` / `parseJson` + `jsonFilter` / `contextBefore` / `contextAfter`
  / `select` / `coalesce`) or `log_follow` → `log_get-followed`. Returned lines are auto-redacted.
- **DB evidence** — `db_connect` (named, prefer `connectionStringEnv`, read-only by default) → schema
  discovery (`db_list-tables` / `db_describe-table`), reads (`db_query`), or before/after state
  (`db_snapshot` + `db_diff`, or `db_watch-changes` + `db_get-changes`). Postgres / MySQL / SQLite.

### Trace correlation

Every backend call auto-injects the active W3C `traceparent`, so the resulting `traceId` chains into
`log_read { pattern: <traceId> }`. `o11y_new-trace-id` / `o11y_set-trace-context` /
`o11y_get-trace-context` pin a trace across a multi-tool flow.

### Backend rules

- Don't infer behavior from code — exercise at least one evidence path against the running service.
- Keep DB connections read-only unless a write is explicitly required (`db_connect` with `allowWrites`,
  then `db_transaction-begin({ writable: true })` / `db_seed` / `db_run-script`).
- Prefer one `execute` script for multi-step flows (e.g. `db_snapshot` → `request_http` → `db_diff`).
