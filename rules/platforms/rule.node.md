<!-- Node platform is ENABLED for this project (ironbee-dt-node MCP server). -->

## Node platform: non-blocking Node.js debugging

Verify Node.js runtime behavior with the IronBee DevTools node tools (`debug_*`) instead of guessing
from code. Attach to a running process, set non-blocking probes at the changed code, exercise the path
so the probe fires, and read the snapshots.

### ⚠️ Node tools are ONLY for Node.js runtimes

`debug_*` wraps the V8 inspector. It does NOT work for Java, Python, Go, Rust, Ruby, .NET, PHP, or any
other runtime. If you see `pom.xml`, `build.gradle`, `requirements.txt`, `pyproject.toml`, `go.mod`,
`Cargo.toml`, etc., the backend is not Node.js — do not call `debug_*`; use the backend platform
instead.

### Node tools & flow

- **Connect** by PID, process name, port, WebSocket URL, or Docker container (`debug_connect`).
- **Probe** the changed code without pausing it: `debug_put-tracepoint` / `debug_put-logpoint` /
  `debug_put-exceptionpoint`, then exercise the path and read `debug_get-probe-snapshots` (or
  `debug_get-logs`).
- **Resolve** bundled/minified stack frames to original source with `debug_resolve-source-location`.
- **Disconnect** (`debug_disconnect`) when done.

Pass criteria: the process connected and a probe actually triggered (or a log path was used with no
unexpected ERROR entries).
