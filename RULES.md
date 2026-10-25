# RULES.md — Product and engineering rules

1. **No code editor.** We manage existing local development projects.
2. **Reliability before feature count.** Start, stop, logs, and cleanup must be trustworthy.
3. **Review before first execution.** Suggestions are not authorization.
4. **Local-first.** No login, telemetry, or cloud account for core functionality.
5. **Never store credentials in project definitions.** Secrets remain in user-controlled environment files or OS secure storage.
6. **No invisible dependency installs or venv mutations.** Explicit consent and clear preview required.
7. **MCP read-only by default.** Minimize exposure, redact secrets, restrict paths, and require approval for actions.
8. **Premium but simple.** Compact sidebar, clear service states, fast searchable logs, accessible controls.
9. **Windows-first, portable design.** Separate OS-specific process handling.
10. **Do not promise zero-config support for arbitrary repositories.** Always provide manual override.
11. **No destructive operations without confirmation.** Clearly label forced process termination.
12. **Keep completed work intact.** No unnecessary rewrites or unsafe shortcuts.
13. **Follow the interface design system.** See `docs/DESIGN_SYSTEM.md` for both themes, shared components, accessibility, and responsive rules.
