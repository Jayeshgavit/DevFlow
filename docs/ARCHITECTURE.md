# Architecture

React UI -> typed Tauri invoke/event bridge -> Rust core -> OS processes.

- Project definitions: local JSON under OS app config directory.
- Detector: inspect known directories and manifests; never execute during scan.
- Runner: launch program directly with argv, not via an arbitrary shell command string; stream stdout/stderr via Tokio.
- Logs: bounded in-memory frontend buffer (4,000 entries), filter/copy/export. Later: redaction, persistence, timestamps, backpressure.
- Process lifecycle: store child handles, poll exit, stop Windows process trees with taskkill; add job objects and graceful shutdown before public release.
- MCP: future localhost/stdio server with read-only project and sanitized-log tools.

## Known engineering risks
- Process exit polling can race with stop/restart and should be hardened.
- Windows `taskkill /F` is abrupt; implement graceful signal support where possible.
- App exit and OS shutdown cleanup need explicit validation.
- Environment and working-directory requirements vary by repository.
- Exposing raw logs can leak tokens. MCP integration requires redaction and access controls.
- npm/pnpm/yarn availability and Python venv selection are environment-dependent.
