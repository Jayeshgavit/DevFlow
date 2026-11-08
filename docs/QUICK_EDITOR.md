# Quick Editor workspace

The navigation sidebar has an explicit collapse/expand button and remembers its setting locally. Icon buttons retain accessible names and tooltips. The editor keeps its own explorer collapse/width controls.

Files open in separate tabs. Opening an existing path selects its tab (case-insensitive for Windows). Each tab retains its draft, disk baseline, preview/edit mode and local snapshot status. Only the active file mounts CodeMirror. Dirty markers cover inactive files too. Closing a dirty tab, changing editor project, reloading disk content or closing the docked application requires confirmation before discarding edits. Save and Ctrl+S still use the existing guarded Rust file API, external-change check, encoding/line-ending preservation and local file snapshots.

## External file changes

Settings → Editor Preferences → External File Changes defaults to **Auto-reload clean files**. All open eligible tabs, including inactive tabs, are checked after relevant Windows directory notifications. Clean tabs refresh without a dialog and show “Updated from disk”; draft text and its disk baseline change together. Existing view/edit mode, syntax/theme/preferences and clamped cursor/selection/scroll are retained where practical. Actual text replacement resets undo history; unchanged disk text does not reset it. Replacing a file with read-only or mixed-ending content disables editing as before.

Dirty tabs keep their exact draft and original disk baseline. An exclamation indicator and compact notice offer **Compare Changes**, **Reload from Disk**, and **Keep My Draft**. Compare is a local side-by-side view of the live draft and disk content read on request, with explicit refresh and no merge. Reload confirms draft discard and rereads disk before applying; if the draft, disk version or owner changed, it stops. Keep My Draft collapses the actions but retains the conflict marker and save-time protection. A missing, linked, oversized, unsupported or inaccessible disk file preserves the tab and offers Retry Reload; it is never recreated or remapped automatically.

**Notify before reloading** keeps content unchanged and offers review/reload/dismiss. **Manual reload only** releases monitoring and leaves explicit Reload and native save-time conflict checks available. Preferences use the existing local settings storage and apply across editor windows. Conflicts transfer in the normal Float/Dock session; the receiver rereads after binding its lease to cover changes during handoff. Only open-file parent folders are watched, with bounded event batching and temporary-access retries. Affected expanded Explorer listings refresh without collapsing folders; other directories still use Explorer Refresh. If a parent directory disappears or monitoring reports a failure, reopen a tab or toggle the preference to retry monitoring. No project files are written and no AI requests are made by synchronization.

Manual acceptance remains required for external in-place and atomic saves, rapid replacements, unchanged-byte writes, clean/dirty inactive tabs, save/reload races, file deletion/recreation, unavailable parents, symlink/junction rejection, Float/Dock during changes, preference changes in both windows, cursor/scroll/undo, and both themes at narrow widths.

### Implementation record — 2026-10-29

Implemented automatic clean-tab refresh, protected dirty-tab conflict actions, missing-file notices, inactive-tab indicators, in-place CodeMirror synchronization, lease-aware watcher handoff, persisted synchronization settings, and background refresh of affected expanded Explorer folders. Existing guarded reads, save-time disk comparisons, snapshots, and writer leases remain the safety boundaries.

| Files | Changes |
| --- | --- |
| `src-tauri/src/quick_editor/watch.rs` (new) | Cancellable Windows notifications for open-file parent directories; bounded event batching; registered-path events with lease and subscription generation. |
| `src-tauri/src/editor_window.rs`, `src-tauri/src/quick_editor.rs`, `src-tauri/src/lib.rs` | Store and release the native registration with editor ownership; expose typed watch/unwatch commands. |
| `src/use-external-file-sync.ts` (new) | Track all open tabs, reread through trusted IPC, retry temporary failures, reject stale reads and changed baselines, and protect dirty drafts. |
| `src/QuickEditor.tsx`, `src/editor-session.ts`, `src/editor-api.ts` | Conflict/reload/compare controls, transferable tab status, current-draft checks, typed watcher calls, and scoped Explorer refresh. |
| `src/EditorSurface.tsx` | Annotated disk-replacement transaction, clamped selection, retained scroll, suppressed edit callbacks, and explicit undo-history reset. |
| `src/EditorPreferences.tsx`, `src/editor-preferences.ts` | Auto, Notify, and Manual modes in the existing preference store. |
| `src/quick-editor.css`, `src/guide-content.ts`, `docs/ARCHITECTURE.md`, `docs/QUICK_EDITOR.md` | Compact theme-aware feedback, responsive comparison, local help, architecture, and workflow documentation. |

Verification performed once each after implementation: `npx tsc --noEmit --pretty false` and `cargo check --manifest-path src-tauri/Cargo.toml -q`; both exited successfully with no output. A scoped `git diff --check` also passed. No production build, full test suite, desktop launch, browser automation, external-provider request, or real-project modification was performed for verification. Native Windows behavior and rendering remain manual acceptance items listed above.

## Native window handoff

Float creates one fixed-label native Tauri window, initially hidden. The main editor hands a serializable session to Rust memory and unmounts. The new window retrieves that session, installs close protection and acknowledges readiness before becoming visible. It loads only the editor root: no dashboard timers, service subscriptions or service actions mount in this window. The initial transfer copy is released on readiness.

Dock, or the native floating window close button, freezes the editor and hands its current session back to Rust. The main window retrieves it and acknowledges receipt; only then is the floating window destroyed and the transfer copy released. Events trigger handoffs; no polling or continuous draft synchronization is used. Transfer includes selected editor project, open files, active tab, drafts, edit modes and explorer width/collapse preference. Startup recovery in the main editor is allowed only while the hidden window has not acknowledged readiness, preventing restoration of a stale snapshot over live floating edits.

DevFlow refuses its main native close request while a floating handoff/session exists and focuses the floating window when available. Dock first, then close DevFlow normally. Handoffs do not invoke any service lifecycle commands. Existing application-exit service cleanup remains unchanged.

## Highlighting and limits

The existing CodeMirror/Lezer language packages provide keyword, variable, function, property, type, string, comment, literal and punctuation colors using separate light/dark CSS tokens. Unsupported languages remain plain text. No editor framework, language server, dependency or background process was added.

- Drafts remain in memory. Process termination, webview crashes and OS shutdown can lose unsaved work; there is no crash-recovery persistence.
- Tab switches and window transfers recreate the active CodeMirror view, resetting cursor/scroll position and undo history. Draft text and edit mode survive. View/edit toggles on the same file retain the existing view.
- At most 20 tabs can be opened; an additional retained-text budget prevents opening more files once approximately 16 MiB of draft/disk text is retained. The existing 2 MiB per-file read/save limit still applies. Dirty-state checks compare cached normalized baselines rather than normalizing every inactive file on each keystroke.
- The editor project selector owns its selection after first opening. Switching the main dashboard project does not discard editor drafts. Changing the editor project still warns for unsaved files.
- The floating project list is loaded from saved configuration at startup. Reopen the floating editor to refresh project additions/removals; Rust still validates every file access against current saved roots.

## A2 local file snapshots

Changed saves in either editor window preserve the previous on-disk UTF-8 content before replacement. Unchanged and stale saves create no history. Files remain limited to 2 MiB. History offers Preview, Compare and confirmed Restore; comparison reads the current local file when requested, independently of Git and unsaved drafts. Unsaved edits to the target block restore. A restore uses the same writer lease, external-change checks and replacement pipeline, snapshots the current disk bytes first, and refreshes the affected tab.

Storage is `<app_local_data_dir>/file-snapshots-v1`, outside project folders. UUID-named JSON records contain timestamp, project ID, canonical absolute file identity, display path and exact text, including BOM and line endings. Records are flushed then published by rename; incomplete staging records are discarded on next access. History persists across restarts, stays with its original project/path, and is not automatically migrated when files move or rename. Missing files cannot be restored or recreated through History.

Retention removes oldest versions before writing: 20 per file, 999 records overall, and 64 MiB including JSON overhead. No project scans, background tasks, polling, cloud or database are used. Sensitive/generated/dependency path exclusions and conservative secret-content heuristics reuse the existing export policy; these heuristics can exclude ordinary source mentioning credentials and are not a complete secret detector. Binary, oversized and non-UTF-8 files are unsupported. History is local plaintext, protected by the user's app-data permissions, not encrypted storage.

Project and storage paths reject traversal, reparse points, symlinks and junctions. History errors block eligible saves rather than proceeding without preservation. Read-only/mixed-ending files remain protected. Windows replacement uses a temporary same-directory backup to check the exact replaced bytes, removing it after success. If an external edit races the final replacement or Windows reports a partial failure, the operation reports an error and recovery location; review/reload the disk before continuing. Such recovery artifacts are exceptional and are outside history retention. Existing recovery copies from earlier releases are not scanned or removed.

A2 manual checks: save from docked/floating windows and Ctrl+S; unchanged saves; restart persistence; Preview/Compare including externally edited files and BOM/CRLF; restore cancellation and dirty-tab protection; successful restore and re-restore; retention eviction; storage failure; missing/renamed files; symlink/junction and excluded-file rejection; keyboard focus and narrow layouts in both themes.

## Validation

Automated: `npm run build`, `cargo check --offline`, `node --test tests/editor-session.test.mjs`, `cargo test --offline --lib editor_window::tests -- --nocapture`, and `cargo test --offline --lib quick_editor::tests -- --nocapture`.

Manual native verification remains required:

1. Collapse/expand navigation and resize in both themes, including narrow windows and keyboard navigation.
2. Edit two files; switch tabs, reopen the same path, cancel a dirty close, save with Ctrl+S and confirm files on disk.
3. Float with multiple dirty files; check project/active tab/text, move/resize, edit, then Dock. Repeat using the native floating close button.
4. While floating, try closing the main window; it should stay open and focus the editor. Dock and test cancelling the final dirty close.
5. Confirm running services keep their existing process IDs through Float/Dock and no duplicate logs/subscriptions appear.
6. Review syntax contrast for representative supported languages in light/dark themes. Inspect startup recovery if window initialization fails.
