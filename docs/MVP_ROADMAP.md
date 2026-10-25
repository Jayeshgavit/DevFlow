# MVP roadmap

## Night 1: working prototype
- [x] Desktop app scaffold
- [x] Local folder import
- [x] Basic manifest/folder detection
- [x] Editable service commands and local workspace persistence
- [x] Start/stop service API
- [x] Stream/filter/search/copy/export logs
- [ ] Compile and verify on Windows
- [ ] Test StatFlare and JG Blogs end-to-end

## Reliability milestone
- [ ] Windows job-object process containment and graceful shutdown
- [ ] Accurate process state and crash reporting
- [ ] Port conflict and readiness checks
- [ ] Automated detection and lifecycle tests
- [ ] Secure log redaction and bounded retention
- [ ] Packaging and installer signing strategy

## Environment milestone
- [ ] Python virtual environment detection and opt-in creation
- [ ] Package manager selection and opt-in installs
- [ ] `.env.example` comparison without storing secrets
- [ ] Docker/Compose detection (no auto-execution)

## MCP milestone
- [ ] Read-only `list_projects`, `get_project_status`, `get_logs`, `search_logs`
- [ ] Explicit client connection instructions for Codex and Claude
- [ ] Authentication/authorization and secret redaction
- [ ] Optional user-approved start/stop actions
