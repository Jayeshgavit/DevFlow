# AGENTS.md — Instructions for coding agents

You are developing DevFlow, a Windows-first local development workspace manager with a focused Quick Editor and read-only AI Assistant. Keep project commands, reliable service control, and logs central; do not turn it into a general-purpose IDE.

Before modifying DevFlow, read docs/ARCHITECTURE.md and inspect only the files relevant to the requested feature. Update the architecture document when module responsibilities or integrations change.

## Primary mission
Import project root -> detect services -> user reviews commands -> one-click run -> separate/combined logs -> stop/restart reliably.

## Stack
Rust + Tokio + Tauri 2 for desktop process management; React 18 + TypeScript + Vite for UI; CodeMirror 6 for Quick Editor. Local JSON persistence, WebView localStorage preferences, and Windows Credential Manager for AI keys. No hosted backend. Explicit AI requests use OpenRouter or NVIDIA NIM; API Tester sends explicit loopback HTTP requests.

## Architecture boundaries
- `src/main.tsx` owns project selection, service actions, native lifecycle subscriptions, and retained logs. `src/project-store.ts` owns serialized configuration saves and load-failure protection.
- `src-tauri/src/lib.rs` registers IPC and owns lifecycle/detection integration. `launcher.rs` and `windows_job.rs` own executable resolution and contained Windows process trees.
- `EditorWorkspace.tsx` / `editor_window.rs` transfer editor ownership and drafts using revisioned writer leases. Floating Logs and service controls use the existing bridges; never create a second collector or process registry.
- `quick_editor.rs` and `quick_editor/*` own saved-root filesystem guards, saves, snapshots, reviewed file creation, and bounded read-only research. Smart Replace changes a draft; saving is separate.
- AI HTTP, credentials, outgoing-content checks, model checks, and research authorization remain in Rust. AI tools cannot write files, run commands, or start services. Web conversation mode does not provide live browsing.
- API Tester, Port Manager, and Developer Environment have separate bounded native modules. Preserve their main-window checks, explicit-action requirements, cancellation, and stale-result guards.
- `src/shortcuts.ts` owns application shortcut scope; preserve CodeMirror/text-control and dialog priority. `src/guide-content.ts` is the local help content source.

## Interface design system
Use `docs/DESIGN_SYSTEM.md` for theme tokens, typography, components, accessibility, and responsive behavior. Keep project control and logs prominent without changing typed Tauri IPC contracts for visual work.

## Rules for modifications
1. Inspect existing files and git status before editing. Preserve user changes.
2. Plan changes briefly, then implement small focused patches. Do not rewrite unrelated files.
3. Never silently execute repository scripts, dependency installs, or shell commands.
4. Do not add arbitrary shell execution or unrestricted MCP write capabilities.
5. Avoid secrets in logs, telemetry, exports, and AI tool output. Preserve display/export masking, reviewed AI snapshots, and final native outgoing validation. Redaction is heuristic; do not claim it detects every secret. MCP remains planned.
6. Use typed Tauri IPC. Keep OS process management in Rust, not frontend shell plugins.
7. Keep UI compact, accessible, and keyboard-friendly. No decorative dashboards.
8. Handle child process cleanup, Windows process trees, duplicate starts, crashes, and port collisions.
9. Add tests for detection and lifecycle changes. Validate Windows behavior explicitly.
10. Never claim a build/test passed unless it actually ran; report exact commands/results.

## Validation
Announce commands before running them. Run checks appropriate to the change; do not install dependencies or launch the desktop app merely to update documentation.

- Frontend build: `npm run build` from the repository root (TypeScript plus Vite).
- Frontend regression tests: `node --test tests/*.test.mjs`, or a relevant subset. There is no npm test or lint script in the current package manifest.
- Rust compile: `cargo check --manifest-path src-tauri/Cargo.toml`.
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml`, or a relevant test filter. Windows lifecycle tests spawn disposable processes; inspect their scope first.
- Desktop verification: `npm run tauri dev` when runtime testing is authorized and needed. Compilation does not verify WebView rendering, clipboard, provider access, native process cleanup, or filesystem races.

## Current priorities and limitations
Detection/persistence tests, Job Object containment, bounded logs/redaction, Quick Editor/history, AI research, and workspace tools already exist. Improve these implementations rather than rebuilding them from old roadmap items. Prioritize Windows acceptance testing, failure recovery, and security boundaries. Automatic dependency/venv installation and MCP are not implemented; consult source before treating planning documents as feature status.

Keep `docs/ARCHITECTURE.md` as the detailed implementation reference, this file as the shared agent policy, and `CLAUDE.md` as a short entry point to both. Update local help when user-visible workflows change. Report source review, automated results, and manual checks separately.

## Acceptance criteria
StatFlare can be imported, manually corrected, saved, launched, logged, and stopped without leaving orphaned services. A second workspace can be stored and reopened.
