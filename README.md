# DevFlow — local development workspace manager

Windows-first Rust + Tauri 2 + React MVP. **Source-code prototype, not a verified production build.**

## Included
- Import a local project root through native folder picker.
- Heuristic detection: `frontend`, `backend`, `client`, `server`; Node `dev` script; simple FastAPI entrypoints.
- Manually add/edit services, executable, arguments (one per line), and working directory.
- Save multiple project configurations in local app config JSON.
- Run/stop services, combined and per-service live stdout/stderr, filter, search, copy, export.
- Windows process-tree stop via `taskkill /T /F` (forced termination; data loss possible for some services).

## Windows setup (PowerShell)
Install Node.js LTS, Rust with MSVC toolchain, Microsoft C++ Build Tools, and WebView2 runtime. See https://v2.tauri.app/start/prerequisites/ .

```powershell
npm install
npm run tauri dev
```

Build installer:
```powershell
npm run tauri build
```

## First test
1. Open DevFlow and import your StatFlare root folder.
2. Check suggested frontend/backend commands; **do not execute unknown scripts**.
3. Edit backend Python executable to your virtual environment Python path when necessary.
4. Click Save changes, then Run all.
5. Inspect logs, stop both services, and verify child processes terminate.

## Important limitations
- Detection is heuristic, not universal. It does not install packages or create virtual environments.
- No MCP server in this version; see `docs/MCP_PLAN.md`.
- Does not provide terminal input/PTY, Docker lifecycle, secrets redaction, or full port health checks.
- Service status is approximate until process exit polling updates it.
- Starting from a missing or incorrectly configured environment will fail and show an error.
- Existing projects may use different working directories or entrypoints; edit manually.
- Do not expose this app to untrusted repositories or run unreviewed commands.
- This source has **not been compiled/tested in this environment**; expect integration fixes before release.
