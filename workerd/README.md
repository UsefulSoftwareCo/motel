# Motel on workerd

The collector can run without Bun or Node. The Bun CLI and TUI remain available.
Both runtimes share the HTTP routes, SQLite schema, OTLP decoder, searches and
retention logic. A single durable object owns the workerd SQLite connection.
Durable alarms run bounded retention and historical FTS backfill while idle.

Build and run from the repository root:

```sh
bun install --frozen-lockfile
bun run web:build
bun run workerd:build
bun run workerd:serve
```

The example listens on `127.0.0.1:27687`. Its data is under
`.local/workerd-data/`; retain that directory across restarts. API and OTLP paths
match the native collector. The build uses Bun, but the running collector only
needs workerd, `dist/workerd`, `web/dist`, and the configuration file.

The workerd version is pinned to Executor's existing runtime. Integrators should
copy this worker module into their workerd configuration and share that binary.
The worker needs a SQLite-enabled `MotelCollector` namespace named `STORE`, a
read-only disk service named `ASSETS`, and persistent local disk storage.
Settings use the same `MOTEL_OTEL_*` names, supplied as text bindings. Health uses
PID 0 because a worker does not own an operating-system process.

The collector's memory and store are bounded by configuration. It reads at most
`MOTEL_OTEL_MAX_PENDING_INGEST` exports at once (default 16), each at most
`MOTEL_OTEL_MAX_INGEST_BYTES` (default 16 MiB). It answers a further export with
429 and `Retry-After: 1`, and an oversized one with 413, and counts both;
`GET /api/ingest` reports the queue and the counts. Spans are written to SQLite
as each export arrives. Every retention pass evicts the oldest completed traces
until the store is within `MOTEL_OTEL_RETENTION_HOURS`, `MOTEL_OTEL_MAX_SPANS`
(default 1,000,000) and `MOTEL_OTEL_MAX_DB_SIZE_MB` (default 1024), spending at
most `MOTEL_OTEL_RETENTION_PASS_BUDGET_MS` (default 500) of writer time.

`bun run workerd:test` runs the built worker as a real process. It verifies HTTP
trace/log ingestion, searches, seven-day retrieval, alarm retention, malformed
payload refusal, and retained data after SIGKILL. Run `bun run workerd:build`
after source changes before this test.

Motel telemetry is disposable. This runtime starts a fresh durable store and does
not import the old native collector file. Keep the workerd directory if telemetry
should survive restarts; it can also be discarded independently of product data.

When embedded in Executor, give Motel its own disk service and directory. It must
not share the product database, migration journal, backup, or readiness gate.
Sharing the workerd executable does not mean sharing a datastore.
