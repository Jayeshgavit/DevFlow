# AGENTS.md — Instructions for coding agents

You are developing DevFlow, a Windows-first local development workspace manager, **not** a code editor.

Before modifying DevFlow, read docs/ARCHITECTURE.md and inspect only the files relevant to the requested feature. Update the architecture document when module responsibilities or integrations change.

## Primary mission
Import project root -> detect services -> user reviews commands -> one-click run -> separate/combined logs -> stop/restart reliably.

## Stack
Rust + Tokio + Tauri 2 for desktop process management; React + TypeScript + Vite for UI. Local JSON config initially. No hosted backend.

## Interface design system
Use `docs/DESIGN_SYSTEM.md` for theme tokens, typography, components, accessibility, and responsive behavior. Keep project control and logs prominent without changing typed Tauri IPC contracts for visual work.

## Rules for modifications
1. Inspect existing files and git status before editing. Preserve user changes.
2. Plan changes briefly, then implement small focused patches. Do not rewrite unrelated files.
3. Never silently execute repository scripts, dependency installs, or shell commands.
4. Do not add arbitrary shell execution or unrestricted MCP write capabilities.
5. Avoid secrets in logs, telemetry, exports, and AI tool output. Add redaction before shipping MCP.
6. Use typed Tauri IPC. Keep OS process management in Rust, not frontend shell plugins.
7. Keep UI compact, accessible, and keyboard-friendly. No decorative dashboards.
8. Handle child process cleanup, Windows process trees, duplicate starts, crashes, and port collisions.
9. Add tests for detection and lifecycle changes. Validate Windows behavior explicitly.
10. Never claim a build/test passed unless it actually ran; report exact commands/results.

## Immediate priorities
- Verify `npm install`, `npm run build`, `cargo check`, and `npm run tauri dev` on Windows.
- Resolve integration issues and add robust process-tree cleanup.
- Add unit tests for project detection and persistence.
- Add per-project logs retention caps and log redaction.
- Only then add Python venv setup and read-only MCP integration.

## Acceptance criteria
StatFlare can be imported, manually corrected, saved, launched, logged, and stopped without leaving orphaned services. A second workspace can be stored and reopened.
