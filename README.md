# motel

A local OpenTelemetry ingest + TUI viewer for development, backed by
SQLite. Point your app's OTLP/HTTP exporters at the local motel server
and debug with real runtime evidence — from a terminal, the built-in web
UI, or directly from an AI coding agent.

## For agents: install the motel-debug skill

`motel` ships a companion skill that teaches Claude Code, OpenCode,
Cursor, Codex, and 40+ other agents how to debug with runtime evidence
by querying motel's local OTLP store. Install it once and any future
agent session in the project will know how to use it.

```bash
# Project-local (adds to .claude/skills, .agents/skills, etc.)
npx skills add kitlangton/motel --skill motel-debug

# Or globally, for every project
npx skills add kitlangton/motel --skill motel-debug -g
```

See the full skill at [`skills/motel-debug/SKILL.md`](skills/motel-debug/SKILL.md).

## For humans: install and run the TUI

motel is distributed on npm as `@kitlangton/motel`. The binary is a Bun
script, so Bun must be on your `PATH` at runtime:

```bash
# one-off (no install)
bunx @kitlangton/motel

# or install globally
bun add -g @kitlangton/motel
motel

# npm also works (Bun still required to run it)
npm install -g @kitlangton/motel
```

Don't have Bun?

```bash
curl -fsSL https://bun.sh/install | bash
```

`motel` starts the local OTLP ingest server on
`http://127.0.0.1:27686` and launches the TUI. Press `?` once inside for
the keyboard cheat sheet, or `c` to copy paste-ready setup instructions
for any Effect/OTEL app you want to trace.

Requirements: [Bun](https://bun.sh/) v1.1 or newer.

## How your app connects

Once motel is running, point your app's OTLP/HTTP exporters at these
local endpoints:

```
http://127.0.0.1:27686/v1/traces
http://127.0.0.1:27686/v1/logs
```

Motel keeps everything in a machine-global local SQLite database at
`${XDG_STATE_HOME:-~/.local/state}/motel/telemetry.sqlite`. One managed
daemon is shared across local projects. No Docker, no cloud account.

The store retains seven days of telemetry by default and targets a 1 GB
active-data ceiling using bounded background batches. Recent data is preserved while
the oldest completed traces and logs are removed first. Configure the policy
with `MOTEL_OTEL_RETENTION_HOURS`, `MOTEL_OTEL_MAX_DB_SIZE_MB`,
`MOTEL_OTEL_RETENTION_TRACE_BATCH`, `MOTEL_OTEL_RETENTION_LOG_BATCH`, and
`MOTEL_OTEL_RETENTION_INTERVAL_SECONDS`. Existing databases created without
incremental auto-vacuum are never silently rewritten at startup; deleted pages
are reused, but shrinking such a historical file requires an explicit offline
SQLite `VACUUM` chosen by the user.

## How agents connect

Agents with the `motel-debug` skill installed will automatically use
motel's HTTP API. The full OpenAPI spec is at
`http://127.0.0.1:27686/openapi.json` — the key endpoints are:

```
GET /api/health                              liveness check
GET /api/services                            services reporting telemetry
GET /api/traces?service=<service>            recent traces for a service
GET /api/traces/<trace-id>                   full trace tree
GET /api/spans/<span-id>                     single span + logs
GET /api/logs?service=<service>              recent logs
GET /api/traces/search?...                   structured trace search
GET /api/logs/search?...                     structured log search
GET /api/ai/calls                            AI SDK call inspector
```

## TUI keys

- `?` — keyboard cheat sheet
- `j` / `k` or `↑` / `↓` — move selection
- `enter` / `esc` — drill in / back out (trace → waterfall → span detail)
- `[` / `]` — switch service
- `tab` — toggle service logs
- `/` — filter traces
- `s` — cycle sort (recent → slowest → errors)
- `t` — cycle theme
- `c` — copy paste-ready setup instructions for another app
- `o` — open selected trace in the browser
- `q` — quit

## Privacy note

motel is a local development tool, but your app can emit sensitive
telemetry. Correlated logs may include secrets, tokens, or PII if your
app logs them; AI call traces may include full prompt content and
response text. Treat the local SQLite store as sensitive development
data when pointing motel at real workloads.
