# CLAUDE.md — DevFlow development entry point

Read and follow [AGENTS.md](AGENTS.md) before making changes. It is the shared project policy for all coding agents. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module ownership, IPC, persistence, safety boundaries, and implementation status; use [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) for UI work.

DevFlow is a Windows-first local development workspace manager built with Rust/Tokio/Tauri 2 and React/TypeScript/Vite. Its core workflow is import → review detected service commands → save → run → inspect logs → stop managed process trees. Quick Editor, read-only AI assistance, and local workspace tools support that workflow.

- Inspect `git status` and relevant current files first; preserve uncommitted changes. Make small scoped patches and reuse existing components and contracts.
- Keep process management and filesystem/security checks in Rust. Preserve Windows Job Object containment, saved-root/link guards, writer leases, disk-change checks, bounded buffers, and explicit destructive confirmations.
- Main owns service state and logs. Floating windows use existing event bridges and editor ownership handoff; do not duplicate registries or collectors.
- AI provider calls require reviewed context and native outgoing checks. Credentials persist in Windows Credential Manager. Research is bounded and read-only; it grants no file-write, terminal, service, or arbitrary network capability.
- Announce shell commands and checks. Use the validation commands in `AGENTS.md`; report exact outcomes and distinguish source review from Windows desktop/provider verification.
- Update architecture when module responsibilities or integrations change. Keep this entry point aligned with `AGENTS.md` instead of duplicating the full architecture or old roadmap priorities.
