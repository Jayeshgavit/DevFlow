# B4: Docked and floating logs

Quick Editor's Show Logs button opens a bottom panel for its editor project. Drag the separator vertically or focus it and use Up/Down (Home/End set the limits). Hide Logs releases the view without clearing history or touching editor tabs. Float Logs opens or focuses that project's single native log window. The Logs page also has Float logs, independently of Quick Editor.

Floating windows can move, minimize, resize, and close normally. None of these paths starts, stops, or restarts services. Dock in Quick Editor requests the current editor owner (main or floating editor), opens the main editor when needed, and closes the log window only after acknowledgement. If the editor already has another project open, select the log window's project there; existing unsaved-change protection applies. Docking never silently discards a draft.

## Shared source

Rust's existing output collectors and service registry are unchanged. The main React app remains the sole consumer of service log events and performs existing ANSI normalization, source deduplication, incident handling, and bounded retention. The main Logs page and docked editor read that same buffer. Remote webviews request a project projection: initial retained history, then revisioned additions/removals and service status. Removal includes clear actions and retention expiry. Remote clear actions resolve row IDs back to original entries in main.

There is one projection per remote window, no polling, and at most one delivery in flight per subscriber; updates coalesce while sending. Hidden editor panels release remote listeners/subscriptions. Native window destruction removes leftover subscriptions. Existing grouping, repeat protection, virtual rows, filters, search, masking for copy/export, and live-follow come from LogViewer and log-utils.

All three views use the same compact Start all / Stop menu, including Stop frontend, Stop backend, Stop both, and Stop all. Remote requests carry only a project ID and an allowed scope; main resolves current configuration and uses the existing Rust manager. Stops require confirmation. Stops can cancel queued bulk starts. Starting, stopping, failures, and active service keys are projected from the same main-window state. History remains session-only and depends on the main app remaining alive, matching the existing log implementation. Filter/search/scroll preferences are local to each view; native float/dock does not transfer these transient controls.

## Manual Windows verification

- Start a saved project's services once. Open Logs, Quick Editor logs, and a floating log window; compare retained/live output and service status without restarting anything.
- Repeat Float for the same project, including when minimized; confirm the existing window is restored and focused. Open a different project's window and confirm isolation.
- Test Combined, Frontend, Backend, service/stream/severity filters, search, copy/export, clear propagation, follow/pause, tracebacks, and repeated error floods. Check retention expiry reaches remote views.
- Resize the panel by pointer and keyboard at minimum editor/window sizes and in both themes. Confirm code selection, tabs, undo, and unsaved text survive showing, hiding, and floating logs.
- Dock with editor unopened, docked, floating, on another project, and during an editor transfer. Confirm no unsaved edits are discarded and the log window closes only after the receiver is ready.
- Close/minimize each auxiliary window and verify services continue. Close main and verify the existing draft and managed-service exit confirmations still apply.

Native interaction, visual layout, high-volume runtime performance, and cross-window delivery require these desktop checks; static and focused unit checks do not establish them.

## Focused validation performed

From the repository root:

```text
node node_modules/typescript/bin/tsc --noEmit
node tests/log-sharing.test.mjs
node tests/editor-session.test.mjs
node --test --test-name-pattern "classifies|groups traceback|uses explicit|flood of identical|source identity|memory budgets|repeat grouping|source ANSI|log stop scopes" tests/log-utils.test.mjs
git diff --check -- src/main.tsx src/components.tsx src-tauri/src/lib.rs
```

All passed: TypeScript had no errors; synchronization tests 3/3; editor-session tests 6/6; selected log regression tests 9/9; whitespace check clean.

From `src-tauri`:

```text
cargo test --offline --lib logs_window::tests -- --nocapture
```

Passed 1/1 (42 other Rust tests filtered out). This compiles the Rust test target but does not launch the application or exercise native window interactions.

The initial Node test-worker invocation encountered sandbox `spawn EPERM`; outside-sandbox reruns worked. Two broader log-utils invocations were interrupted in slow retention-loop cases; neither is counted as passed. The final selected log regression command above passed. No full application build, full test suite, or browser/native interaction test was completed.


## Logs actions update (2026-10-27)

- Copy actions and per-row buttons use the same bounded Windows CF_UNICODETEXT command, with allocation checks and short retries for clipboard contention. Success feedback and menu closing follow a successful native write. Failures remain visible and retryable. Redaction still runs before copy/export; it remains best effort.
- Copy selection snapshots selected text before menu focus changes and adds source/timestamp metadata. Entry checkboxes select complete buffered lines/blocks independently of browser text selection. Expired entries and changed filters clear stale selections.
- Visible output/errors/warnings refer to viewport groups. Current filtered view covers the entire matching buffer. All combined/role/error copies explicitly refer to their named project-wide scope. Copy last 50/100/500 uses only the buffered selected service/stream and ignores text/severity filters. App-wide DevFlow incident notices remain visible alongside the selected project; unrelated project output is excluded.
- Error context and AI prompts contain at most 200 buffered lines, with up to two nearby lines on each side, deduplicated and ordered, within the same project/service/run. The output states its limit.
- Export filtered logs shows a sensitive-information warning, then a parented native Save dialog. Rust writes UTF-8 only to the user's chosen destination. Cancel is distinct from success. There is no upload or unrestricted frontend filesystem permission.
- Clear view / filters resets filtering and selection. Clear matching buffered history separately confirms removal from the shared session history in all windows. It never deletes files or stops services.
- Options retain font/stream/slow-request settings and add persisted timestamp/service-label visibility. Follow/Pause stays directly accessible. Ctrl+F focuses log search; Escape clears focused search. F8 / Shift+F8 navigate matching errors; Alt+F8 / Alt+Shift+F8 navigate matching warnings. Menu Escape, outside click, keyboard navigation, and viewport clamping remain shared.
- Open in Quick Editor is offered only for explicit Windows absolute `file:line[:column]` or Python `File "...", line N` locations after native verification. Rust reuses saved-root, traversal, junction, regular UTF-8 file, size, and line-count checks, and verifies again at click time. Relative/ambiguous/missing locations have no action. A pending native request handles an unopened editor; existing drafts and project-switch confirmation remain in force. Markdown locations open their source read-only.

Validation of this update:

```text
npm run build
cargo check --offline                         # from src-tauri
cargo test --offline --lib                    # from src-tauri, outside sandbox
node --test tests/log-utils.test.mjs tests/log-sharing.test.mjs tests/bulk-actions.test.mjs tests/project-service-state.test.mjs tests/editor-session.test.mjs
node --test --test-name-pattern="copy scope|error locations|error context" tests/log-utils.test.mjs
```

The combined Node regression run passed 39/39 before the final copy-scope test was added; the focused new regression run passed 3/3. Rust's full suite passed 42/43 outside the sandbox, including Windows lifecycle/owned-descendant cleanup tests. The remaining detection test compares a canonical long Windows interpreter path against a short-form Temp path; this assertion is outside the Logs changes. The initial sandbox run also encountered access-denied errors in file replacement/process cleanup tests; those passed outside the sandbox.

Native clipboard round trips across the three windows, Save dialog interaction/cancellation, menu layout at minimum sizes, and error-link handoff with unsaved editor drafts still require desktop interaction verification. Builds/unit checks do not establish those UI results.
