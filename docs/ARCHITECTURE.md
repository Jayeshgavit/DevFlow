# DevFlow architecture and codebase reference

Reviewed against the current local source, including uncommitted changes, on 2026-10-28. Paths are repository-relative. This is an implementation reference, not runtime certification. This documentation update does not establish build, desktop, provider, or Windows acceptance-test success.

Read `AGENTS.md` for shared development rules and `CLAUDE.md` for the Claude entry point. Planning documents describe intent; the current source and command registry establish implementation status.

## 1. Tech stack

| Layer | Actual dependencies / implementation |
| --- | --- |
| **Desktop framework** | Tauri 2 (`@tauri-apps/api` ^2.0.0, `@tauri-apps/plugin-dialog` ^2.0.0, `tauri` 2, `tauri-plugin-dialog` 2, `tauri-plugin-notification` 2.7) |
| **Frontend UI** | React 18.3.1, TypeScript 5.6.0 (strict), Vite 6.0.0, Lucide React ^0.468.0, plain CSS stylesheets |
| **Quick Editor** | CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`, `@lezer/highlight`), lazy syntax modes (`lang-javascript`, `lang-python`, `lang-json`, `lang-html`, `lang-css`, `lang-markdown`), Markdown preview (`react-markdown` ^10.1.0, `remark-gfm` ^4.0.1) |
| **Typography** | Local `@fontsource/inter`, `@fontsource/space-grotesk`, `@fontsource/jetbrains-mono` |
| **Backend core** | Rust 2021 edition, `tokio` 1 (features: `process`, `io-util`, `sync`, `time`, `net`, `macros`), `serde` 1 + `serde_json` 1, `ignore` 0.4 (directory walking & export filters) |
| **HTTP and streams** | Native `reqwest` 0.13 with JSON, streaming and native TLS; `futures-util` 0.3. Provider HTTP stays in Rust. |
| **Windows native** | `windows-sys` 0.61.2 (Win32 APIs: Job Objects, processes, threads, Toolhelp, memory, performance, filesystem, COM, shell, messaging), `windows` 0.62.2 (`Win32_Graphics_Dxgi`) |
| **Persistence** | Local JSON configuration (`projects.json`) and snapshot records (`file-snapshots-v1`); WebView `localStorage` for UI preferences. No hosted DevFlow backend or remote telemetry. Explicit AI requests contact external providers; API Tester contacts loopback HTTP endpoints. |

---

## 2. High-level architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          React 18 Frontend                             │
│  (App / Overview / Projects / Logs / QuickEditor / SystemCenter / etc) │
└──────────────────┬────────────────────────────────▲────────────────────┘
                   │ Typed Tauri invoke()           │ Tauri events (emit)
                   │ (requests & leases)            │ (logs, exits, diagnostics)
┌──────────────────▼────────────────────────────────┴────────────────────┐
│                          Tauri 2 Rust Core                             │
│   (AppState, WindowsJob, ProjectStorage, QuickEditor, SystemCenter)   │
└──────────────────┬────────────────────────────────▲────────────────────┘
                   │ Win32 / std::process           │ Stdio pipes & Job telemetry
                   ▼                                │
┌───────────────────────────────────────────────────┴────────────────────┐
│                    Windows OS / Host Filesystem                        │
│   - Windows Job Objects (contained process trees, hard termination)    │
│   - Bounded path traversal / reparse point & junction rejection        │
│   - System performance queries (GetProcessTimes, PDH, Toolhelp, Dxgi)  │
└────────────────────────────────────────────────────────────────────────┘
```

- **Entry point**: `index.html` loads `src/main.tsx`.
- **Rust initialization**: `src-tauri/src/main.rs` invokes `devflow_lib::run()` in `src-tauri/src/lib.rs`, which builds Tauri, registers plugins, initializes state managers, sets window close handlers, and registers all Tauri commands.
- **Routing & Views**: No external router library. Navigation uses a typed `View` state union (`overview | projects | ports | environment | logs | api | editor | system | maintenance | settings`). Secondary windows (`quick-editor`, `logs-*`) load `index.html` with query parameters (`?window=quick-editor`, `?window=logs&project=...`) and mount specialized views (`FloatingEditor`, `FloatingLogs`).
- **Data flow**: Main window is the primary subscriber to native log streams and exit events. Secondary windows subscribe to projected data via window bridges.

---

## 3. Feature-based file map

### 3.1 App shell, navigation, routing
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `index.html` | Application HTML shell, root element `#root`. | `src/main.tsx` | App title, viewport metadata |
| `src/main.tsx` | Application orchestrator: `App`, top-level state, view switching, project selection, modal dialogs, window close handling. Secondary window root branches: `FloatingEditor`, `FloatingLogs`. | `src/components.tsx`, `src/types.ts`, `src/project-store.ts`, `src/EditorWorkspace.tsx`, `src/SharedLogs.tsx` | Adding top-level views, modifying shell layout or navigation shortcuts |
| `src/types.ts` | Shared domain contracts: `View`, `Theme`, `Project`, `Service`, `RunOption`, `HealthSnapshot`, `LogLine`, `ServiceExit`, `serviceKey`. | Universal frontend import | Adding navigation views or global entity fields |
| `src/style.css` | Global styling, theme tokens (light/dark/system), typography, layouts, density. | `src/main.tsx`, `src/components.tsx` | Global theme variables, shell spacing, buttons (consult `docs/DESIGN_SYSTEM.md`) |

### 3.2 Projects and configuration
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/project-store.ts` | `ProjectStore`: load status, revision tracking, dirty flags, serialized save (`save`, `updateAndSave`), transactional `edit`, `renameProject`. Prevents writes before successful load. | `src/main.tsx`, Tauri IPC (`load_projects`, `save_projects`) | Modifying project state machine or save ordering |
| `src/components.tsx` | Project configuration UI: `ServiceRow`, `AddServiceDialog`, `RenameProjectDialog`, `ProjectShortcuts`. | `src/main.tsx`, `src/types.ts` | Service configuration cards, command inputs, add/rename dialogs |
| `src-tauri/src/lib.rs` | Tauri commands: `load_projects`, `save_projects`. Configuration directory locator `storage_path`. | `src-tauri/src/project_storage.rs`, `AppState` | Backend project loading or configuration file location |
| `src-tauri/src/project_storage.rs` | Project storage validation: `validate_projects` (absolute paths, no NUL bytes, unique IDs, port ranges), GUID generator `new_id`, atomic write `save_file` (`projects.<id>.tmp` -> `projects.json`). | `src-tauri/src/lib.rs` | Storage validation rules, atomic file write strategies |

### 3.3 Service detection and Start/Stop controls
Add Service reuses the native dialog directory picker and `suggest_service` IPC. Its `Auto` mode inspects exactly the selected directory through the existing detectors (without scanning project-root siblings); `Custom` validates the directory without proposing a command. The modal keeps an editable draft, labels detected recommendations and manual overrides, and ignores stale inspection results. Adding validates the directory again and persists `Service.cwd` through `ProjectStore.updateAndSave`. Launch and restart continue using the saved service working directory through the existing Rust launcher; selection and inspection never start a process.

| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src-tauri/src/lib.rs` | Detection engine: `detect_project`, `discover_services`, `suggest_service`, `node_service`, `cargo_service`, `python_service`, `python_sources`, `python_module`. Heuristic scanning for Node, Rust/Cargo, and Python (FastAPI/Flask/Django) services without silent code execution. | `src-tauri/src/launcher.rs` | Adding new framework/runtime detectors or suggestion logic |
| `src/main.tsx` | Service execution handlers: `start`, `requestStop`, `restart`, `runProject`, `stopAllConfirmation`. Port conflict handling and suggestion application. | `src/bulk-actions.ts`, `src/project-service-state.ts` | Modifying start/stop click flows or retry prompts |
| `src/bulk-actions.ts` | `runBulkAction`: Sequences start/stop across multiple services, skips in-flight starts, provides step-by-step progress, handles cancellation. | `src/main.tsx` | Changing bulk startup order, concurrency, or timeout behavior |
| `src/ProjectServiceControls.tsx` | Shared control bridge: `ProjectServicesContext`, `useProjectServicesBridge`, `RemoteProjectServices`, `ProjectServiceAction`, `LogsServiceControls`. Allows secondary windows to trigger service actions in main window. | `src/main.tsx`, `src/SharedLogs.tsx`, `src/QuickEditor.tsx` | Adding cross-window service control actions |
| `src/project-service-state.ts` | `projectServiceState`: Derives active counts, stopping state, and `stopAllConfirmation` warning messages. | `src/main.tsx`, `src/ProjectServiceControls.tsx` | Modifying confirmation text or running service state derivation |

### 3.4 Process lifecycle and health checks
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src-tauri/src/lib.rs` | Process manager: `AppState`, `StartGuard` (reserves service key, checks port collisions), `start_service`, `stop_service`, `stop_owned_service`, `running_services`, `stopping_services`, `managed_service_count`, `shutdown_app`. Exit monitoring task. | `src-tauri/src/windows_job.rs`, `src-tauri/src/launcher.rs`, `src-tauri/src/service_output.rs` | Lifecycle state transitions, shutdown orchestration, process reservations |
| `src-tauri/src/windows_job.rs` | Windows containment: `WindowsJob`, `spawn_contained`. Suspended process creation (`CREATE_SUSPENDED`), Job Object assignment, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, process tree termination. | `src-tauri/src/lib.rs` | Process tree containment, job limits, Windows handle management |
| `src-tauri/src/launcher.rs` | Command launcher: `resolve_program`, `declared_port`, `script_kind`, `batch_command_line`. Resolves Windows executables (.exe, .cmd, .bat, PowerShell) with safe argument construction. | `src-tauri/src/lib.rs` | Windows executable resolution or shell script execution rules |
| `src-tauri/src/lib.rs` (HTTP check) | `check_service_health`: Validates loopback-only targets (`127.0.0.1`, `::1`), executes bounded HTTP probes via Tokio TCP stream with status code validation. | `src/main.tsx`, `src/components.tsx` | Health check network logic or probe parameters |
| `src/service-health-utils.ts` | Pure helpers: `healthSummary`, port conflict indicators, health status styling. | `src/components.tsx`, `src/service-health-dashboard.tsx` | Health status summary logic |
| `src/service-health-dashboard.tsx` | `ServiceHealthDashboard`: Standalone overview table of service health and metrics (*present, currently unmounted*). | `src/service-health-dashboard.css` | Health dashboard UI enhancements |

### 3.5 Logs, filters, clipboard, export
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src-tauri/src/service_output.rs` | Output collector: `collect`. Reads asynchronous stdout/stderr pipes, chunks lines (up to 16 KiB chunks, 128 lines / 64 KiB batches, 50 ms flush), bounds memory. | `src-tauri/src/lib.rs` | Pipe chunking, output batching intervals, backpressure |
| `src/log-utils.ts` | Pure log engine: `appendLogs`, `logBytes` (caps: 10K lines/8 MiB per service, 20K lines/16 MiB per project, 40K lines/32 MiB per session), `createSourceDeduper`, `createAnsiLogNormalizer`, `groupLogs`, `redactForSharing`, `parseErrorLocation`, `buildAiDebugPrompt`. | `src/main.tsx`, `src/SharedLogs.tsx`, `src/components.tsx` | Retention caps, ANSI parsing, secret redaction patterns, stack trace parsing |
| `src/log-actions.ts` | Frontend log action helpers: `writeLogClipboard` (`logs_copy`), `exportLogText` (`logs_export`), `verifyErrorLocation`, `openErrorLocation`. | `src-tauri/src/log_actions.rs`, `src/components.tsx` | Clipboard and file export caller logic |
| `src-tauri/src/log_actions.rs` | Native log actions: `logs_copy` (Win32 clipboard), `logs_export` (Tauri file save dialog), `logs_verify_location`, `logs_open_location`, `logs_take_location`. | `src/log-actions.ts`, `src-tauri/src/logs_window.rs` | Native clipboard integration, export dialog, file/line jump routing |
| `src/components.tsx` (`LogViewer`) | `LogViewer`: Virtualized log console, level filters, service filters, text search, follow mode, ANSI rendering, error-location links. | `src/log-viewport.tsx`, `src/log-console.css` | Log console UI, search highlighting, filter tabs |
| `src/log-viewport.tsx` | `LogViewport`: High-performance measured row virtualizer for smooth rendering of thousands of log entries. | `src/components.tsx` | Virtual scroll measurement, row height calculation |
| `src/SharedLogs.tsx` | Log sharing: `LogsContext`, `useLogsBridge`, `ProjectLogs`, `FloatingLogs`, `floatLogs`. Synchronizes log frames and exposes checked entries to Quick Editor AI when requested. | `src/log-sharing.ts`, `src-tauri/src/logs_window.rs`, `QuickEditor.tsx` | Cross-window log synchronization and opt-in AI log attachment |
| `src/log-sharing.ts` | `createLogFrames`, `applyLogFrame`: Computes incremental delta frames and resets for multi-window log mirroring. | `src/SharedLogs.tsx` | Frame delta computation, sequence reconciliation |

### 3.6 Quick Editor, file explorer, and AI Assistant

Project-wide text search lives in `src/ProjectSearch.tsx` and `src-tauri/src/quick_editor/search.rs`, with typed `editor_search` / `editor_cancel_search` wrappers in `editor-api.ts`. The Explorer panel debounces input by 300 ms, rejects stale responses, groups results by file and renders 100 matches per page. `shortcuts.ts` routes Ctrl+Shift+F through the active editor; result navigation reuses the existing location flow and adds optional Unicode-aware column positioning in `EditorSurface.tsx`. Existing drafts are retained; search results always describe disk text.

The same panel offers project replacement through a read-only `editor_preview_replace` command. It prepares fresh original/proposed contents for at most 100 matching files, 1,000 replacements and 16 MiB combined text, preserving BOM and line endings. Literal replacement treats dollar signs literally; regex replacement supports numbered/named captures and `$$` with bounded incremental expansion. Read-only, mixed-ending and oversized output files fail preparation. Limited/cancelled search results and unsaved target drafts block replacement. Review shows named files, counts and explicitly bounded before/after excerpts; changing query, replacement, project or dirty targets invalidates it. Confirmation saves the reviewed files through existing `editor_save`, never a second write path. `QuickEditor.tsx` holds the existing work lock, verifies writer ownership and all original disk contents before starting, then saves sequentially with per-file optimistic checks, eligible pre-save snapshots and atomic file replacement. Clean open tabs receive the saved content; drafts remain protected. A multi-file batch is not atomic: failures stop later saves and report confirmed successful paths plus the error; earlier saves remain. No AI tool can call this operation.

Native scans use the existing saved-root resolver, ancestor locks and 2 MiB UTF-8 reader on blocking workers. The existing `ignore` walker respects ignore rules without following links; fixed dependency/build folders are skipped. The direct `regex` dependency supplies literal escaping, Unicode whole-word/case options and bounded regex compilation; optional comma-separated include/exclude globs use `ignore` matchers. Each window owns one cancellation registration; replacement, explicit Stop, component cleanup or window destruction cancels its matching scan. Work is bounded to 1,000 matches, 20,000 yielded entries, approximately 10 seconds, depth 64 and a 64 MiB read budget (at most one 2 MiB file beyond the budget); result flags identify partial scans and counts report unreadable/unsupported skipped files. Filesystem calls are synchronous and cancellation observes checkpoints rather than interrupting an OS call. Saved-root configuration is rechecked before returning results. Search is local and read-only, independent of AI research authorization/export policies; results never enter provider context automatically. Native/WebView interaction and large-project latency require manual verification.
External file synchronization uses `quick_editor/watch.rs` and `use-external-file-sync.ts`. The existing `EditorWindow` holds one cancellable, lease-checked Windows registration. It watches only the immediate parent directories of up to 20 open tabs, nonrecursively, through Win32 change notification handles (no new dependency, polling, subtree scans, or service integration). A single waiting worker coalesces directory signals over 180 ms, with a 750 ms maximum batch interval, then emits registered relative paths and the frontend generation to the owner. Generated/dependency directories are excluded. Handoff cancels the previous registration; the receiver registers after acquiring its writer lease and rechecks all open files to cover the transition gap. Cleanup includes registration-generation checks so stale cleanup cannot cancel a newer subscription.

All content is reread through `editor_read`, including bounded retries for temporary replacement/access failures; notifications never authorize paths. Exact content equality avoids unnecessary state/undo changes. Clean tabs update their document and normalized baseline together; dirty tabs retain both their draft and old disk baseline and carry a transferable conflict/missing indicator. Async results are checked against project/root, subscription generation, notification revision, current draft state, operation locks and the native lease. Save-time concurrency/snapshot guards remain authoritative. Explicit reload rereads after confirmation and refuses a changed draft or a newer disk version. Active CodeMirror text replacement uses an annotated transaction with clamped selection and retained scroll, suppresses draft callbacks, and resets incompatible undo history without remounting; inactive tabs receive the same cached state update. The existing local editor preferences store persists Auto (default), Notify, and Manual modes across windows; Manual releases the watcher. Only affected expanded Explorer parent listings refresh in the background, without a loading-state collapse. Other directories retain explicit Refresh. Missing parent folders or notification-handle failures require reopening a tab or changing the synchronization preference to retry monitoring; drafts and manual guarded reads remain available.

Brain Queue (A7) is a collapsible Quick Editor Explorer panel in `src/BrainQueue.tsx` with task/note/prompt types, progress, filters, and expandable multiline text. It stores bounded items in WebView `localStorage` under a versioned key per stable project ID (100 items, 4,000 characters each). The component remounts on project selection, validates saved records including older items without a type, and does not read or write project files, editor drafts, or AI services. Its styles are in `brain-queue.css`.
Paste as New File (A6) is an explicit clipboard → review → create → open workflow. `src/paste-new-file.ts` reuses the A5 fenced-content parser with separate file/path extraction (including Windows separators and Copy for AI metadata). `src/PasteAsNewFile.tsx` and `src/paste-new-file.css` provide multi-block selection, editable destinations, explicit folder/path conflict resolution, syntax previews, missing-directory consent, and per-file results. Folder/root context menus and the Edit menu in `QuickEditor.tsx` launch it. The typed `editor_create_files` IPC in `quick_editor/paste_new.rs` handles both read-only preview and confirmed batch creation under the existing writer lease and filesystem mutex. It reuses saved-root verification, Windows filename/exclusion checks, directory handle guards and reparse rejection; validates the complete batch before writes, then rechecks guarded ancestors and uses `create_new` for each file. Input is bounded to 20 supported text files / 256 KiB total. Partial failures retain and report new files and directories without rollback deletion. Successful creation refreshes expanded Explorer folders and opens tabs while preserving drafts. No save/snapshot engine, service execution, background clipboard monitoring or dependency is added. Native clipboard, ACL/race failures, floating-window ownership, focus and responsive rendering require manual verification.

Smart Replace (A5) is a human-initiated clipboard-to-draft workflow. `src/smart-replace.ts` parses separate fenced/plain clipboard blocks, validates relative path syntax, matches named JS/TS/Python declarations using existing Lezer parser ranges and conservative name heuristics, and constructs exact replacement hunks. `src/SmartReplace.tsx` owns block/target/range/mode selection and diff review; whole-file mode and existing dirty drafts require explicit consent. Other eligible text languages use explicit selection or whole-file mode when no supported declaration match exists. `QuickEditor.tsx` integrates the Edit/context menus, guarded target reads, bounded on-demand filename lookup (24 folders / 400 entries / depth 4), preview invalidation, disk rechecks, and writer-lease validation. Target/content eligibility reuses the Rust export-validation guards, so A5 conservatively limits input and resulting drafts to 256 KiB and rejects potentially sensitive content. No new IPC or Rust write path exists. Applying changes only the in-memory draft; the current CodeMirror surface receives a single undoable range transaction. Existing `editor_save` remains the only persistence path and creates the A2 pre-save snapshot with optimistic disk concurrency checks. Apply itself creates no on-disk snapshot. Native clipboard access, Windows leases, rendering, and manual save/restore remain runtime verification items.

| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/QuickEditor.tsx` | Quick Editor shell: File tree explorer, multi-tab management, dirty state tracking, line ending preservation, save/reload, file creation/rename, error location jump, AI assistant panel toggle and horizontal resize split. | `src/EditorSurface.tsx`, `src/EditorContextMenu.tsx`, `src/EditorHistory.tsx`, `src/AiAssistantPanel.tsx`, `src/editor-api.ts` | Editor layout, tab management, file tree interactions, AI panel toggle |
| `src/AiAssistantPanel.tsx` | AI Assistant panel: Provider and credential controls, streaming chat, and explicit context attachment previews with per-snapshot review before sending. | `src/QuickEditor.tsx`, `src/ai-api.ts`, `src/ai-context.ts`, `src/ai-assistant-panel.css` | AI chat and reviewed attachment controls |
| AI conversation modes | Composer selection persists locally: Chat answers normally with optional reviewed attachments, Research alone requests a project-bound read-only token, and Web uses model knowledge with no project history or browsing. Rust owns the mode-specific system instruction and rejects tokens outside Research. Unsafe/failed local messages remain visible but are omitted from later requests; diagnostic path replacements require a reviewed composer edit. | `src/AiAssistantPanel.tsx`, `src/ai-context.ts`, `src-tauri/src/ai_chat.rs` | Prompt boundaries and outgoing request safety |
| `src/ai-context.ts` | AI context safety helpers: bounded attachment formatting, UTF-8 byte accounting, selectable context budgets, attachment formatting, and renderer-side validation of native-prepared snapshots. | `src/AiAssistantPanel.tsx`, `src/QuickEditor.tsx`, `src/log-utils.ts` | Attachment formatting and content checks |
| `src/ai-api.ts` | Typed IPC wrapper for AI: `aiApi` (`setApiKey`, `deleteApiKey`, `getCredentialStatus`, `testConnection`, `listModels`, `startChat`, `stopChat`, `subscribeChatStream`). Filters streaming events by `requestId` for multi-window isolation. | `src/AiAssistantPanel.tsx`, `src-tauri/src/lib.rs` | AI frontend IPC contracts, stream subscription |
| `src/ai-assistant-panel.css` | AI Assistant styles: Theme-tokenized panel layout, message bubbles, fenced code blocks with copy buttons, streaming cursor, API key modal dialog, reviewed attachment previews, composer layout, responsive clamp sizing. | `src/AiAssistantPanel.tsx` | AI Assistant side panel styling and design tokens |
| `src-tauri/src/ai_credentials.rs` | Windows Credential Manager integration: Secure local storage (`CredWriteW`, `CredReadW`, `CredDeleteW`) for OpenRouter and NVIDIA NIM API keys. Automatic key masking (`sk-or-v1-••••1234`, `nvapi-••••1234`). New keys pass through the credential entry form and typed IPC once; saved keys are not returned in plaintext. Only masked status is returned to the UI. | `src-tauri/src/ai_chat.rs`, `src-tauri/src/lib.rs` | Windows credential persistence and secret redaction |
| `src-tauri/src/ai_chat.rs` | AI provider HTTP client and streaming completion engine: Connection testing, live model discovery without hardcoded catalog fallback, SSE stream processing, cancellation tokens (`oneshot`), bounded conversation/attachment limits, final secret/path request scan, and window-targeted event emission (`ai-chat-delta`). | `src-tauri/src/ai_credentials.rs`, `src-tauri/src/lib.rs` | Provider HTTP clients, SSE parsing, cancellation, final request safety checks |
| `src/EditorSurface.tsx` | CodeMirror 6 integration: Lazy language extension loading, theme styling, scroll syncing, text selection API, Markdown live preview toggle. | `src/QuickEditor.tsx`, CodeMirror packages | Code editor keymaps, extensions, code highlighting |
| `src/editor-api.ts` | Typed IPC wrapper: `editorApi` (`list`, `read`, `save`, `mutate`, `export`, AI file validation, `reveal`, `lease`, `history`, `snapshot`, `restore`). Text normalization and `aiContext` builder. | `src-tauri/src/quick_editor.rs`, `src-tauri/src/quick_editor/actions.rs` | Editor IPC contracts, AI context snippet generation |
| `src/editor-session.ts` | Pure session helpers: `openTab`, `closeTab`, `updateDraft`, `renameTab`, `dirtyTabs`. | `src/QuickEditor.tsx`, `tests/editor-session.test.mjs` | Tab state transitions, dirty tracking logic |
| `src/EditorContextMenu.tsx` | Context menus for file tree and editor tabs: New file, new folder, rename, reveal in Explorer, export context. | `src/QuickEditor.tsx`, `src/quick-editor.css` | Tree context menu actions |
| `src-tauri/src/quick_editor.rs` | Native file engine: `editor_list`, `editor_read`, `editor_save`. Restricts access strictly to saved project roots. Guards against path traversal, symlinks, junctions, reparse points (`guard_directories`). Max file size 2 MiB. | `src-tauri/src/quick_editor/actions.rs`, `src-tauri/src/quick_editor/snapshots.rs` | File security validation, filesystem I/O constraints |
| `src-tauri/src/quick_editor/actions.rs` | Native editor actions: `editor_export` (reads file/folder/tree with exclusions and validates AI source paths up to the editor's 2 MiB limit), `editor_mutate` (create file/folder, rename), `editor_reveal` (Explorer select). | `src-tauri/src/quick_editor.rs` | Export exclusions, file creation/rename security rules |

### 3.7 Floating/docked editor and Logs windows
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/EditorWorkspace.tsx` | Window docking orchestrator: `EditorWorkspace`, `FloatingEditor`, `WindowCloseHandler`. Coordinates writer lease handoff and draft transfer between main and floating windows. | `src/QuickEditor.tsx`, `src-tauri/src/editor_window.rs` | Editor docking/floating UI transitions and close guards |
| `src-tauri/src/editor_window.rs` | Window session manager: `EditorWindow`, `Session` (owner: `main`, `floating`, `opening`, `docking`). Commands: `editor_writer_lease`, `editor_window_session`, `editor_float`, `editor_window_ready`, `editor_dock`, `editor_accept_dock`, `editor_recover_opening`, `editor_close`. | `src/EditorWorkspace.tsx`, `src-tauri/src/quick_editor.rs` | Editor window handoff protocol and writer lease validation |
| `src/SharedLogs.tsx` | Floating logs UI: `FloatingLogs`, `floatLogs`, `floatingLogsProject`. Detects floating log window mode via query parameters. | `src-tauri/src/logs_window.rs` | Floating log window interface |
| `src-tauri/src/logs_window.rs` | Native logs window manager: `LogsWindows`. Commands: `logs_float`, `logs_project`, `logs_dock`, `logs_pending`, `logs_accept_dock`. Window label: `logs-<project_id_hex>`. | `src/SharedLogs.tsx`, `src-tauri/src/lib.rs` | Floating logs window creation, focus, and docking lifecycle |

### 3.8 File snapshots/history/restore
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/EditorHistory.tsx` | History comparison UI: `EditorHistory`. Visual diff comparison between current file text and previous snapshots, restore confirmation. | `src/QuickEditor.tsx`, `src/editor-api.ts` | File version history list, diff presentation |
| `src-tauri/src/quick_editor/snapshots.rs` | Snapshot engine: `before_save`, `editor_history`, `editor_snapshot`, `editor_restore`. Automatic snapshot before save. Enforces 20 versions/file, 999 retained versions overall (1,000-entry scan guard), 64 MiB total storage cap. Sensitive content and excluded files are skipped. | `src-tauri/src/quick_editor.rs` | Snapshot pruning rules, sensitive content filters, restore validation |

### 3.9 Settings and local persistence
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/main.tsx` (Settings view) | Appearance preferences (theme: light/dark/system, compact layout switch), editable keyboard bindings, editor preferences, chat storage, notifications, and local User Guide. | `src/components.tsx`, `localStorage` | Adding application settings or appearance toggles |
| `src/project-store.ts` | Local persistence orchestrator for workspace projects. Manages `projects.json` load/save cycles and in-memory caches. | `src-tauri/src/lib.rs` | Project metadata persistence logic |
| `src-tauri/src/project_storage.rs` | Low-level storage: atomic file save with `.tmp` staging and safe rename. | `src-tauri/src/lib.rs` | Storage path management and atomic persistence |

### 3.10 Notifications and error handling
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/notifications.ts` | Incident manager: `NotificationStore`, `Incident`, `IncidentReason`, `Diagnostic`. In-memory incident log deduplication, 300-event cap, 30-day max age, secret masking (`safe()`). Links incidents to project/service destinations. | `src/NotificationCenter.tsx`, `src/main.tsx` | Incident classification, notification retention, toast triggers |
| `src/NotificationCenter.tsx` | Notification center UI: `NotificationCenter` popover, unread counter, `NotificationSettings` preferences, `OperationNotice` banner. | `src/notifications.ts`, `src/notifications.css` | Notification center popover UI, preference controls |
| `src-tauri/src/notifications.rs` | Native notification bridge: `show_desktop_notification`, `DesktopAlerts` (10s throttle), `initialize` (action click router), `diagnostic` (`reports_port_conflict`). | `src/notifications.ts` | OS desktop toast integration, port conflict detection strings |
| `src/operation-error.ts` | `errorMessage`: Extracts and normalizes error messages from diverse error types and IPC rejections. | Universal frontend import | Error message parsing and normalization |
| `src/use-operation-error.ts` | `useOperationError`: React hook providing auto-dismissing, manually dismissible operation error banner state. | `src/main.tsx`, `src/QuickEditor.tsx` | Operation banner timing or dismissal behavior |

### 3.11 Shared hooks, utilities, and UI components
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/components.tsx` | Shared UI library: `Sidebar`, `Button`, `Card`, `Status`, `EmptyState`, `ConfirmDialog`, `QuickSearchDialog`, `ProjectShortcuts`. | Universal frontend import | Reusable design system components |
| `src/menu-dismissal.ts` | `useMenuDismissal`: Hook for outside-click and Escape key detection for context menus and dropdowns. | `src/EditorContextMenu.tsx`, `src/NotificationCenter.tsx` | Overlay and dropdown dismissal behavior |
| `src/SystemCenter.tsx` | Windows monitoring UI: `SystemCenter`. Hardware graphs (CPU, RAM, GPU, Disks), process inspector with confirmation-gated End Task, temp file cleaner, system maintenance. | `src/system-api.ts` | System monitor dashboards, maintenance UI |
| `src/system-api.ts` | System IPC contract: `systemApi` (`snapshot`, `endTask`, `scan`, `clean`, `scanCleanup`, `cleanSelectedCleanup`, `cancel`, `flushDns`, `storage`). | `src-tauri/src/system_center.rs` | System Center frontend API methods |
| `src-tauri/src/system_center.rs` | Windows system implementation: CPU ticks, process snapshot via Toolhelp32, memory via `GlobalMemoryStatusEx`, GPU via PDH counters / DXGI, disk metrics via `GetDiskFreeSpaceExW`. Protected process kill prevention. Safe temp scan/cleaning. | `src-tauri/src/lib.rs` | Windows telemetry collection, safe file cleaner paths |
| `src-tauri/src/system_center_unavailable.rs` | Non-Windows stub reporting features as unavailable. | `src-tauri/src/lib.rs` | Cross-platform fallback messages |

### Workspace tools, help, and shortcut ownership

| Files | Responsibility / integration |
| --- | --- |
| `src/Overview.tsx`, `src/overview.css` | Existing project/service evidence and notification activity; no automatic inspections or synthetic metrics. |
| `src/PortManager.tsx`, `src/port-manager.css`, `src-tauri/src/port_manager.rs` | Explicit bounded native TCP listener inspection; checked managed-service stop by run token. |
| `src/DeveloperEnvironment.tsx`, `src/developer-environment.css`, `src-tauri/src/developer_environment.rs` | Fixed executable/version checks and bounded saved-root manifest inspection; no installer. |
| `src/ApiTester.tsx`, `src/ApiExplorer.tsx`, `src/ApiTextEditor.tsx` | Project-scoped requests, source/OpenAPI discovery, editable endpoint selection, response display. |
| `src/api-tester-api.ts`, `src/api-tester-state.ts`, `src/api-discovery.ts`, `src/api-tester-format.worker.ts`, `src-tauri/src/api_tester.rs` | Typed transport, local request state, bounded explicit discovery, formatting worker, loopback transport and safe persistence. |
| `src/shortcuts.ts`, `src/KeyboardSettings.tsx` | Scoped shortcut registry, validated editable bindings, localStorage synchronization; dialogs and embedded controls keep priority. |
| `src/UserGuide.tsx`, `src/guide-content.ts`, `src/user-guide.css` | Local searchable help dialog and contextual links. DOM events `devflow-guide-open` and `devflow-guide-navigate`; no external docs fetch. |
| `src/ChatStorageSettings.tsx`, `src/chat-history.ts`, `src-tauri/src/chat_history.rs` | Revision/lease-protected project conversations, export, explicit storage selection/migration. |
| `src-tauri/src/ai_provider.rs`, `src-tauri/src/ai_model_check.rs`, `src-tauri/src/quick_editor/research.rs` | Fixed provider protocol/catalogs, explicit synthetic model probes, and authorized read-only project tools. |

### 3.12 Tests and configuration
| File path | Responsibility | Where changes start |
| --- | --- | --- |
| `tests/project-store*.test.mjs` | Project store operations: loading, saving, editing, renaming, removing projects. | Adding project store unit tests |
| `tests/bulk-actions.test.mjs` | Bulk action sequencing, error handling, cancellation. | Adding bulk action unit tests |
| `tests/project-service-state.test.mjs` | Service status calculation and stop confirmation text. | Adding service state tests |
| `tests/log-utils.test.mjs` | Log retention caps, byte calculations, ANSI normalization, grouping, redacting. | Adding log parser/retention tests |
| `tests/log-sharing.test.mjs` | Log frame creation, reset, and synchronization across windows. | Adding log sharing protocol tests |
| `tests/editor-session.test.mjs` | Quick Editor tab opening, closing, renaming, dirty status. | Adding editor session unit tests |
| `tests/notifications.test.mjs` | Incident recording, deduplication, preferences, safe secret masking. | Adding notification unit tests |
| `tests/window-notifications.test.mjs` | Multi-window notification routing and error location linking. | Adding window notification tests |
| `src-tauri/src/lib.rs` (tests) | Inline Rust tests: detection fixtures (FastAPI, Vite/React), duplicate start rejection, process containment, Job Object cleanup. | Adding Rust backend integration tests |
| `src-tauri/Cargo.toml`, `build.rs` | Rust crate manifest, dependencies, Windows SDK features, Tauri build script. | Adding Rust dependencies or build configurations |
| `src-tauri/tauri.conf.json` | Tauri configuration: window dimensions, bundle ID (`com.devflow.desktop`), build commands. | Window properties, security settings |
| `src-tauri/capabilities/*.json` | Tauri 2 capability definitions (`default.json`, `editor.json`, `logs.json`). | Window IPC permissions |
| `package.json`, `tsconfig.json`, `vite.config.ts` | Node packages, scripts (`dev`, `build`, `tauri`), strict TypeScript rules, Vite local server config (port 1420). | Frontend build and compile settings |

---

## 4. Rust ↔ React contracts

All Tauri commands are registered in `devflow_lib::run()` inside `src-tauri/src/lib.rs` via `tauri::generate_handler!`.

### Registered Tauri commands

| Domain | Command name | Input parameters | Return type | Responsibility |
| --- | --- | --- | --- | --- |
| **Projects** | `load_projects` | *(none)* | `Vec<Project>` | Reads validated `projects.json` from config directory. |
| | `save_projects` | `projects: Vec<Project>` | `()` | Validates and atomically writes `projects.json`. |
| | `detect_project` | `root: String` | `Project` | Scans root for Node, Python, and Cargo services. |
| | `discover_services`| `root: String` | `Vec<Service>` | Discovers unconfigured services in a project folder. |
| | `suggest_service` | `root: String, service: Service` | `Service` | Suggests configuration updates for an existing service. |
| **Lifecycle** | `start_service` | `project_id: String, service: Service` | `()` | Reserves port, spawns contained process, attaches pipes. |
| | `stop_service` | `project_id: String, service_id: String` | `()` | Signals and terminates owned Windows Job Object process tree. |
| | `running_services` | *(none)* | `Vec<String>` | Returns active `projectId::serviceId` keys. |
| | `stopping_services`| *(none)* | `Vec<String>` | Returns keys currently in termination phase. |
| | `check_service_health` | `service: Service` | `HealthSnapshot` | Loopback HTTP probe (`127.0.0.1`/`::1`) with status validation. |
| | `managed_service_count` | *(window: WebviewWindow)* | `usize` | Counts active managed processes before closing. |
| | `shutdown_app` | `confirmed: bool` | `()` | Stops owned service trees and exits; application-level graceful shutdown is not guaranteed. |
| **Log actions** | `logs_copy` | `text: String` | `()` | Copies text to Windows native clipboard. |
| | `logs_export` | `project_id: String, text: String` | `bool` | Opens native Save As dialog and writes log output. |
| | `logs_verify_location` | `project_id: String, expected_root: String, path: String, line: usize` | `bool` | Verifies existence of file/line reference in project. |
| | `logs_open_location` | `project_id: String, expected_root: String, path: String, line: usize` | `()` | Emits location event to active editor window. |
| | `logs_take_location` | *(none)* | `Option<ErrorLocation>` | Retrieves and clears pending error location for editor. |
| **Logs window**| `logs_float` | `project_id: String` | `()` | Opens or focuses floating `logs-<id>` window. |
| | `logs_project` | *(window: WebviewWindow)* | `Project` | Resolves project associated with current logs window. |
| | `logs_dock` | `project_id: String` | `()` | Initiates dock transfer of logs back to main window. |
| | `logs_pending` | `project_id: String` | `bool` | Checks if a dock request is pending for project. |
| | `logs_accept_dock` | `project_id: String` | `()` | Confirms dock completion and closes logs window. |
| **Editor files** | `editor_list` | `project_id: String, expected_root: String, path: String` | `Vec<FileEntry>` | Lists directory entries with security checks. |
| | `editor_read` | `project_id: String, expected_root: String, path: String` | `FileDocument` | Reads UTF-8 file content (≤2 MiB limit). |
| | `editor_save` | `project_id: String, expected_root: String, path: String, expected: String, content: String, lease: u64` | `String` | Validates lease, creates pre-save snapshot, writes file atomically. |
| | `editor_mutate` | `project_id: String, expected_root: String, path: String, action: String, name: String, lease: u64` | `String` | Creates file/folder or renames without overwrite. |
| | `editor_reveal` | `project_id: String, expected_root: String, path: String, directory: bool` | `()` | Highlights file/folder in Windows Explorer. |
| | `editor_export` | `project_id: String, expected_root: String, path: String, mode: String, draft: Option<String>` | `CopyExport` | Collects file or tree content for AI context with exclusions. |
| **Snapshots** | `editor_history` | `project_id: String, expected_root: String, path: String` | `FileHistory` | Lists available snapshot versions for a file. |
| | `editor_snapshot` | `project_id: String, expected_root: String, path: String, id: String` | `FileComparison`| Fetches snapshot content for comparison. |
| | `editor_restore` | `project_id: String, expected_root: String, path: String, id: String, expected: String, lease: u64` | `FileDocument` | Restores snapshot version with conflict detection. |
| **Editor window**| `editor_writer_lease` | *(window: WebviewWindow)* | `u64` | Issues current writer revision lease to authorized owner. |
| | `editor_window_session` | *(none)* | `Session` | Fetches active editor handoff session metadata. |
| | `editor_float` | `snapshot: Value` | `()` | Initiates floating editor window transfer. |
| | `editor_window_ready` | *(none)* | `()` | Signals floating editor is open and ready for ownership. |
| | `editor_dock` | `snapshot: Value` | `()` | Initiates docking editor transfer back to main. |
| | `editor_accept_dock` | *(none)* | `Value` | Adopts docked editor state into main window. |
| | `editor_recover_opening`| *(none)* | `Option<Value>` | Recovers draft if floating window creation failed. |
| | `editor_close` | *(none)* | `()` | Closes editor window safely after draft checks. |
| **Notifications**| `show_desktop_notification` | `incident_id: String` | `()` | Displays native Windows desktop toast (throttled). |
| **System** | `system_snapshot` | `force_hardware: bool` | `SystemSnapshot` | Collects CPU, memory, uptime, drives, and GPU metrics. |
| | `system_end_task` | `pid: u32, created: Option<String>` | `String` | Terminates non-critical, non-job process safely. |
| | `scan_temp_files` | *(none)* | `TempPreview` | Scans user Temp folders for candidates. |
| | `clean_temp_files`| `scan_id: String, selected: Vec<u32>` | `CleanupResult` | Cleans selected user temp files. |
| | `scan_cleanup` | *(none)* | `TempPreview` | Scans pre-approved cleanup categories. |
| | `clean_selected_cleanup`| `scan_id: String, categories: Vec<String>` | `CleanupResult` | Cleans selected system cleanup categories. |
| | `cancel_system_maintenance` | *(none)* | `()` | Cancels in-progress file scans or cleanup operations. |
| | `flush_dns_cache`| *(none)* | `String` | Flushes Windows DNS client resolver cache. |
| | `open_storage_tool`| `tool: String` | `String` | Opens Windows Storage Settings or Disk Cleanup. |
| | `open_local_url` | `url: String` | `()` | Opens validated `http://localhost` / `127.0.0.1` in default browser. |
| **AI Assistant (A3)** | `ai_set_api_key` | `provider: String, key: String` | `()` | Stores API key securely in Windows Credential Manager. |
| | `ai_delete_api_key` | `provider: String` | `()` | Deletes provider API key from Windows Credential Manager. |
| | `ai_get_credential_status` | `provider: String` | `CredentialStatus` | Returns whether key exists and masked preview (`sk-...1234`). |
| | `ai_test_connection` | `provider: String` | `TestConnectionResult` | Tests connection with official provider API. |
| | `ai_list_models` | `provider: String` | `Vec<AiModelInfo>` | Retrieves the live provider catalog; failures do not substitute models. |
| | `ai_start_chat` | `request: StartChatRequest` | `()` | Starts background streaming chat completion task. |
| | `ai_stop_chat` | `request_id: String` | `bool` | Cancels active streaming chat via cancellation token. |
| **External** | `open_directory` | `path: String, mode: String` | `()` | Opens directory in Explorer or preferred terminal. |
| | `open_in_ai_cli` | `root: String` | `()` | Launches user-configured AI CLI in project root. |

### Additional registered commands

These complete the registry above. Exact request/response fields live in the named Rust module and its TypeScript wrapper; injected Tauri window/state arguments are not frontend payload fields.

| Domain / native module | Commands | Contract boundary |
| --- | --- | --- |
| Port Manager (`port_manager.rs`) | `inspect_ports`, `stop_port_service` | Main-window inspection and verified managed-run stop. |
| Environment (`developer_environment.rs`) | `check_tool`, `check_project_requirements` | Main window; fixed tool IDs or saved project/root. |
| API Tester (`api_tester.rs`) | `api_tester_source`, `api_tester_prepare`, `api_tester_send`, `api_tester_cancel`, `api_tester_load`, `api_tester_save` | Main window, project binding, request reservation/cancellation, revisioned local storage. |
| Chat storage (`chat_history.rs`) | `chat_storage_location`, `chat_storage_pick`, `chat_storage_apply`, `chat_history_export`, `chat_history_load`, `chat_history_save` | Saved project identity; writes check writer lease, location and revision. |
| Reviewed file creation (`quick_editor/paste_new.rs`) | `editor_create_files` | Preview or confirmed bounded batch under writer lease; no overwrite. |
| AI validation (`ai_chat.rs`) | `ai_prepare_content` | Bounded sanitization proposal for review, without changing files. |
| AI probes (`ai_model_check.rs`) | `ai_check_model` | Explicit provider/model/mode check; may consume provider credits. |
| Research (`quick_editor/research.rs`) | `ai_research_context`, `ai_clear_research_context` | Window/project/root/lease-bound token. Model tools are internal Rust dispatch, not unrestricted IPC. |

### Tauri event contracts

| Event name | Producer → Consumer | Payload | Purpose |
| --- | --- | --- | --- |
| `service-log-batch` | Rust backend → Main window | `{ projectId, serviceId, stream, runId, lines }` | Batched stdout/stderr log output lines. |
| `service-log` | Rust backend → Main window | `{ projectId, serviceId, stream, message }` | Single system / lifecycle log messages. |
| `service-exit` | Rust backend → Main window | `{ projectId, serviceId, exitCode, status, stopRequested, runId }` | Process exit notification. |
| `service-diagnostic` | Rust backend → Main window | `{ projectId, serviceId, kind }` | Port conflict or log collection diagnostic alert. |
| `notification-open` | Rust backend → Main window | `incidentId: string` | Focuses window and opens incident details from desktop toast click. |
| `app-close-requested` | Rust backend → Owner window | `()` | Intercepted window close; requests clean draft check and shutdown confirmation. |
| `editor-docked` | Rust backend → Main window | `()` | Signals floating editor docked; main retrieves draft state. |
| `editor-closed` | Rust backend → Main window | `()` | Signals editor window closed; resets owner state. |
| `editor-close` | Rust backend → Floating editor | `()` | Instructs floating editor to verify drafts and close. |
| `logs-dock-requested` | Rust backend → Floating logs | `projectId: string` | Requests floating logs window to dock into main. |
| `logs-open-location` | Rust backend → Editor window | `{ path, line }` | Instructs editor to navigate to file and line number. |
| `logs-window-closed` | Rust backend → Main window | `windowLabel: string` | Informs main that a floating logs window was closed. |
| `ai-chat-delta` | Rust backend → Target window | `ChatStreamChunk` | Incremental streaming chat token delta, completion signal, or cancellation/error. |

Frontend bridges additionally use `logs-subscribe`, `logs-unsubscribe`, `logs-frame`, and `logs-clear` (`SharedLogs.tsx` / `log-sharing.ts`), plus `project-services-subscribe`, `project-services-state`, `project-services-action`, and `project-services-result` (`ProjectServiceControls.tsx`). Preserve target validation, frame tokens/revisions, and main-window ownership.

### Managed backend state & Window labels

- **`AppState`**: Holds in-memory map of `ProcessEntry` (`Starting`, `Running`, `Stopping`), `exiting` atomic flag, and `projects_loaded` status.
- **`WindowsJob`**: Encapsulates Windows Job Object handle for each running service tree.
- **`QuickEditor`**: File access synchronization mutex.
- **`EditorWindow`**: Manages editor handoff `Session` (`owner`, `snapshot`, `revision`).
- **`LogsWindows`**: Tracks floating log windows, pending docks, and target navigation locations.
- **`DesktopAlerts`**: Throttles native Windows notifications (10-second interval).
- **`SystemCenter`**: Caches system performance queries and maintenance cancellation tokens.
- **`AiChatState`**: Tracks active streaming chat requests and cancellation senders (`tokio::sync::oneshot`).
- **`ResearchState`**: Window-bound project research authorization and invalidation.
- **`ApiTester`**: Single native active request reservation and shutdown cancellation.
- **Window labels**:
  - `main`: Primary application shell.
  - `quick-editor`: Standalone floating editor window (`?window=quick-editor`).
  - `logs-<hex>`: Floating logs window (`?window=logs&project=logs-<hex>`), where `<hex>` is the lowercase hex-encoded UTF-8 project ID.

---

## 5. Data and storage

| Data category | Storage location & lifetime | Format / Limits | Persistence mechanism |
| --- | --- | --- | --- |
| **Project configurations** | `%APPDATA%\com.devflow.desktop\projects.json` | JSON format. Validated schema: unique IDs, absolute roots, sanitized program names. | Persistent. Saved atomically via `save_file` (`projects.<id>.tmp` -> `projects.json`). Leaves `projects.previous.<id>.json` on replace. |
| **File snapshots** | `%LOCALAPPDATA%\com.devflow.desktop\file-snapshots-v1\` | JSON records: `{ id, timestamp, project, file, path, content }`. | Persistent across sessions. Bounded: 20 versions/file, 999 retained versions overall (1,000-entry scan guard), 64 MiB total store. Oldest pruned automatically. |
| **Active project files** | User workspace directories on disk | Raw source files (UTF-8). Max size 2 MiB in Quick Editor. | Direct filesystem writes with temporary staging (`.devflow-*.tmp`) and `.bak` fallback. |
| **UI preferences** | Chromium WebView `localStorage` | Key-value pairs: `devflow-theme`, `devflow-compact`, `devflow-recent`, `devflow-sidebar-collapsed`, `devflow-editor-width`, etc. | Managed by WebView2 runtime on local machine. |
| **AI conversations** | `app_data_dir()/ai-chats-v1/project-<hex>.json`, or explicitly selected custom directory | 100 chats / 8 MiB per project; revisions and writer leases; no automatic pruning. `ai-chat-storage.json` stores the location. | Redacted persisted history/drafts; reviewed attachments stay memory-only. |
| **AI credentials** | Windows Credential Manager | Provider-scoped key records; masked status returned to UI. | No plaintext key in JSON/localStorage. |
| **API Tester** | `app_data_dir()/api-tester-v1/project-<hex>.json` | Revisioned bounded JSON; credentials/session-only fields excluded. | Native validated persistence; see B1 policy below. |
| **Brain Queue** | Chromium WebView `localStorage` (`devflow-brain-queue-v1:<project ID>`) | Per-project JSON array; at most 100 items and 4,000 characters per item. | Saved on user changes; malformed records ignored. |
| **Incident history** | Chromium WebView `localStorage` (`devflow-notifications-v1`) | JSON format. Capped at 300 records and 30-day age limit. | Persistent. Managed by `NotificationStore`. |
| **Service output logs** | In-memory only (`src/main.tsx` React state) | Bounded log buffers: 10,000 lines / 8 MB per service; 20,000 lines / 16 MB per project; 40,000 lines / 32 MB per session. | Ephemeral. Cleared when application closes. Exportable to disk via user action. |
| **Process handles & Jobs** | In-memory only (`AppState` in Rust backend) | Tokio `Child` handles and Win32 Job Object handles. | Ephemeral. All processes terminated and Jobs closed on application exit. |
| **Editor drafts** | In-memory only (`QuickEditor` React state & `EditorWindow` handoff) | Unsaved tab drafts and revision leases. | Ephemeral. Unsaved drafts prompt user before close; no silent discard. |

---

## 6. Safety rules

1. **Managed process containment**: Every service is launched in a dedicated Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Process termination terminates the entire process tree, preventing orphaned descendant processes. Service Stop must use owned Job Objects, never PID/name/port discovery. System Center has a separate guarded End Task workflow for eligible unmanaged processes; Port Manager stops verified managed services only.
2. **Safe file access**: Quick Editor operations strictly require path validation inside saved project roots. Rejects directory traversal (`..`), path separators in components, colon streams (`:`), NUL bytes, symlinks, NTFS junctions, and reparse points. Ancestor directories are held with non-delete-sharing handles during writes to prevent junction swapping.
3. **Draft preservation & writer leases**: Editor file writes require a valid writer revision lease. Floating and docked windows transfer ownership through an explicit handoff protocol. Window close events check for dirty drafts and require confirmation before discarding.
4. **Secret handling & redaction**: Never save credentials or secrets in project configurations. Logs display and sharing use best-effort `redactForSharing()` masking. AI uses native outgoing checks, reviewed sanitization proposals, and guarded source exports; these are distinct policies, not a universal guarantee that secrets are removed. Raw logs remain local and are never transmitted automatically.
5. **Bounded resource allocation**: Output collection is batched and chunked (16 KiB chunks, 50 ms flush). Service logs have strict line and byte caps. Snapshot storage is capped at 64 MiB. Large files (>2 MiB) are blocked from Quick Editor.
6. **No arbitrary shell execution**: Service execution requires explicit program and argument lists reviewed by the user. Constrained batch scripts run via dedicated wrappers; arbitrary unrestricted shell commands or silent installs are prohibited.

---

## 7. Feature status

| Feature area | Implementation status | Evidence in codebase |
| --- | --- | --- |
| **Project import & detection** | **Implemented** | Heuristic detection for Node.js (npm/yarn/pnpm), Rust (Cargo), and Python (FastAPI/Flask/Django/uvicorn). Manual configuration overrides supported. |
| **Service lifecycle** | **Implemented** | Start, stop, restart, bulk actions, and shutdown cleanup backed by Windows Job Objects. Port conflict detection and reservation tracking. |
| **Loopback health checks** | **Implemented** | Configurable HTTP health checks restricted to loopback (`127.0.0.1`/`::1`) with status code ranges. |
| **Health dashboard** | **Present, unintegrated** | `src/service-health-dashboard.tsx` is implemented but not currently routed or mounted in `src/main.tsx`. |
| **Log viewing & filtering** | **Implemented** | Virtualized log viewer (`LogViewport`), ANSI color rendering, search, level filters, service filters, HTTP request parsing. |
| **Native clipboard & export** | **Implemented** | Native Win32 clipboard copy (`logs_copy`), file export dialog (`logs_export`), stack trace file:line location jump. |
| **Quick Editor** | **Implemented** | Multi-tab editor with CodeMirror 6, lazy language syntax, live Markdown preview, file tree explorer, atomic save. |
| **Floating/docked windows** | **Implemented** | Floating editor and per-project floating logs windows with clean lease-based handoff and docking protocols. |
| **File snapshot history** | **Implemented** | Pre-save snapshot engine with diff comparison and conflict-guarded restore (`file-snapshots-v1`). |
| **System Center** | **Implemented (Windows)** | System telemetry (CPU, RAM, GPU, Disks), process inspector with safe End Task, temp file cleaner, DNS flush. Non-Windows platforms use fallback stub. |
| **Incident notifications** | **Implemented** | In-app notification center with deduplication, severity levels, and throttled native Windows desktop toasts. |
| **A3 AI Chat / Assistant** | **Chat, attachments, and Research implemented** | OpenRouter and NVIDIA NIM, Windows Credential Manager, model discovery, SSE streaming/cancellation, and explicit reviewed attachments for active files/drafts, selected code, checked/recent-error Logs, and bounded project metadata/tree context. Research adds five bounded read-only project tools. AI cannot write files, run commands, or control services. |
| **Workspace tools** | **Implemented in source** | Overview, API Tester/discovery, Port Manager, Developer Environment, editable shortcuts and local help. Native runtime behavior requires verification. |
| **Verification status** | **Source reviewed for this update** | No build, test, app launch, provider request, or real termination was run for this documentation update. Windows acceptance remains a separate check. |

---

## 8. AI Assistant: Phases and Roadmap

### Phase 1: UI Foundation (Implemented)
- Embedded collapsible right-side side panel in Quick Editor (docked & floating).
- Header with provider/model selector, New Chat, Close actions.
- Scrollable message list with user and assistant bubbles.
- Markdown and fenced-code block rendering with Copy actions.
- Multiline composer with Enter to send / Shift+Enter for newline.
- Quick prompt starter chips: Explain code, Debug error, Review selected code.

### Phase 2: Secure AI Chat Integration (Implemented)
- **Rust provider client**: Native HTTP requests originating in Rust (`reqwest` with native TLS). Stored keys are read only by Rust; new keys enter through the UI credential form. Do not log keys or return stored plaintext.
- **Windows Credential Manager**: Local key persistence using `CredWriteW`, `CredReadW`, `CredDeleteW`. Keys are masked (`sk-...1234`) and never sent back to the frontend in plaintext.
- **Provider support**: Official endpoints for OpenRouter and NVIDIA NIM.
- **Model discovery**: Live retrieval from fixed official provider endpoints. Catalog failures remain visible; no hardcoded model substitution.
- **Streaming chat completion**: SSE stream parsing with real-time token emission via window-targeted `ai-chat-delta` events.
- **Cancellation**: Tokio oneshot cancellation tokens for immediate Stop Generating.
- **Multi-window safety**: Every request carries a unique `requestId` to prevent cross-window conversation pollution.
- **AI boundary**: No file modification, terminal access, or service control. Research alone enables bounded read-only tools. Outgoing message text is capped at 1 MiB / 20 messages; attachment and serialized-payload budgets are separate.

### Phase 3: Context Attachments (Implemented)
- Attachments are explicit snapshots. Active files and selected code use the safe editor export checks; unsaved content is labeled and never saved as a side effect.
- Selected Logs come from checked, current-project rows or bounded recent error context. Existing filters and copy operations remain available.
- Project context uses the bounded safe tree export and configured framework/role metadata without transmitting source contents.
- Attachments are removable and previewable. New snapshots require a review confirmation before a request and are removed after sending, starting a new chat, or switching projects.
- Redaction, renderer checks, and a final Rust request scan reject credentials, secret-like values, and absolute paths. Each attachment including metadata is capped at 256 KiB. Combined budgets are 16/64/256/512 KiB (64 KiB default); displayed UTF-8 bytes are not token counts. See AI attachment budgets below.


## A3 Phase 4: on-demand read-only project research

Implemented on the existing AI Assistant/Quick Editor integration. `src-tauri/src/quick_editor/research.rs` owns five model-facing tools: `list_directory`, `search_files`, `search_code`, `read_file`, and `read_project_guidance`. It reuses Quick Editor relative-path validation, ancestor directory locks, reparse-point checks, locked UTF-8 reads and export exclusion/language/content checks. The shared text reader now accepts a bounded internal byte limit; editor limits remain 2 MiB, research reads use 256 KiB. No research write, shell, service, URL-fetch or execution tool exists.

`ai_research_context(projectId, expectedRoot, lease)` verifies the saved root and current editor ownership and issues an opaque, window-bound token. `ai_clear_research_context(token)` invalidates only that window's matching token. `StartChatRequest.research_token` is optional; models cannot supply roots or project IDs through tools. Context is revalidated before each provider round and filesystem operation, and after each operation. Active turns observe context invalidation, editor lease changes, saved root changes, window destruction and Stop; a cancellation flag also ends blocking scans. Window-scoped request registrations and targeted-only events prevent cross-window stop/delta delivery. Panel remounts on project/root/lease changes to separate conversation/source evidence.

`ai_chat.rs` accumulates streamed OpenAI-compatible function-call fragments by index, requires a complete finish marker, validates the five-name allowlist and strict Rust argument structs, executes tools in blocking tasks and returns bounded, explicitly untrusted tool messages for subsequent provider rounds. Source/guidance never become system instructions. OpenRouter and NVIDIA NIM use the existing fixed provider endpoints and credentials; no provider/model substitution occurs. Unsupported/rejected tool requests stop with guidance to select a compatible model or disable Research. A turn with no tool calls explicitly discloses that no files were inspected. Normal chat and reviewed file/log attachments remain available.

Directory pages inspect at most 100 entries, return basic type/size metadata, and allow expanding any permitted folder at practical filesystem depth. Searches use resumable, request-local DFS iterators rather than an index or whole-tree collection. Search cursors bind to the exact query/filter/path and expire with the turn. Traversal holds directory guards; linked paths, dependency/generated/secret names, unsupported/binary/non-UTF-8/oversized/potentially sensitive files are omitted. Conservative content checks can omit legitimate authentication source; results disclose omissions. Filename patterns use substring or `*`/`?`; code searches are literal with optional case folding and filename filters, without semantic symbol-resolution claims.

Limits: 16 calls, 12 KiB per serialized result, 64 KiB unique tool-result context and 256 KiB cumulative retransmitted tool-result context per turn; 256 KiB per file; 200 lines per read (120 default); 40 search rows; 10,000 scanned entries / 8 MiB source reads / 3 seconds per search page; 180 seconds per turn and 90 seconds per provider request. Search DFS permits up to 256 simultaneous directory levels; folder expansion is independent of recursive search depth. Directory offsets cap at 1,000,000 and reflect live filesystem enumeration, so external folder changes can shift pages. Limits, next page/line cursors, omitted files and truncated snippets are explicit. There is no background project scan/index.

The existing panel adds a read-only Research toggle, compact activity, and source links. Rust emits verified path/line references separately from model text; only returned references become editor buttons. Links reuse the existing Quick Editor location/line-jump flow. Tests use disposable fixtures and synthetic provider deltas, without provider API calls. Native provider compatibility, floating/docked transitions and Windows junction scenarios require desktop/manual verification; source descriptions here do not establish runtime success.


### AI panel model defaults and controls

NVIDIA NIM automatic selection is resolved exclusively from its current live catalog; there is no fixed default ID or stale fallback list. Both providers load catalogs after a key is configured. The panel displays the automatic NVIDIA choice and sends that concrete ID, so one research turn remains bound to the chosen model. An empty NVIDIA model sent directly over IPC resolves from the live catalog before the request is registered. Optional Change permits an explicit override, isolated from OpenRouter. Explicit selections absent from a refreshed catalog remain visible with an explanation and block Send until corrected; failures never substitute another model/provider. Catalog request generations reject stale responses and model selection does not refetch catalogs.

New Chat preserves the previous conversation and resets the panel; existing cancellation/request guards ignore stale stream callbacks. Clear Chat is a separate confirmed action, blocked while streaming: it persists an empty version of the current conversation through the existing revision/lease-protected history queue, retains its ID/title and all other chats, then clears messages, prompt, attachment review and attachments. Persistence failure retains the current UI content. Delete Chat and Clear All History remain separately confirmed saved-history operations. Credentials and provider/model choices are retained. Message copy actions live below completed responses, and fenced blocks retain source-based Copy Code actions. One compact Attach menu exposes the existing file/selection/log/project handlers and on-demand project browser; removable snapshot chips show UTF-8 byte sizes, unsaved labels and exact content previews. Attachment redaction is idempotent and revalidation refuses to send content differing from the reviewed snapshot. Live provider and visual desktop verification remain manual.

The final outgoing scan in `ai_chat.rs` now supplies category/line diagnostics and is reused by the existing guarded export/research content check. It checks concrete key/token shapes, credential assignments/literal setter arguments and local paths, rather than blanket `.env` or credential-name substrings. Exact environment references and nonsecret identifiers such as `max_tokens` are allowed; genuine/uncertain credential values remain blocked. Drive-path matching requires a boundary so HTTPS URLs are not mistaken for Windows drives. File path exclusions, saved-root validation, ignore rules and linked-path guards remain enforced. Existing frontend sharing redaction masks recognized values and local paths before preview; files containing actual or uncertain credentials are still refused by native eligibility checks. No AI write or command capability is added.


### Explicit model availability checks

`ai_model_check.rs` adds typed `ai_check_model(provider, model, research)` IPC. It probes only the selected fixed provider chat endpoint using the saved key and a synthetic prompt; no project content is sent and returned tool calls are never executed. Chat checks require a completed nonempty text answer. Research checks expose the same five tool schemas and require a valid named `list_directory` call with the empty root path and zero offset. This verifies one streamed tool-call response, not full multi-turn research or semantic answer quality. Green means that probe passed; red means the current chat/research probe was rejected or failed its required tool-call shape. Credential/credit/rate-limit/network/server errors, incomplete responses and timeouts stay gray/inconclusive. Results are account-, provider-, model- and mode-specific, point-in-time observations, not guarantees of future availability.

Checks run only through explicit panel actions: Check selected or Check next 5 (up to five untested loaded models sequentially, stopping on account, network, cooldown or server failures; model-specific incomplete probes can continue to the next candidate). Each may consume provider credits. There are no automatic catalog probes, background polling or retries. Results stay in panel memory, show a check time and color/text labels in the picker, and reset after key changes. Provider/mode changes or panel unmount cancel pending checks and invalidate late results. One probe per window shares the existing four-request global cap; Stop checks uses window-scoped `ai_stop_chat` with the reserved `model-check` ID. Cancellation keeps a request reservation until its owning task unregisters, preventing a late cancelled task from deleting a replacement request. Each check has a 45-second total timeout, 256 output tokens and a 64 KiB streamed response cap. Provider errors and completion contents are not exposed to the UI, only fixed status explanations. Tests cover synthetic success/rejection, malformed tool output and inconclusive account/provider states without real API calls.


### Provider integration: live catalogs, quotas and streaming

`src-tauri/src/ai_provider.rs` shares fixed provider URLs, authenticated requests, redirect rejection, bounded JSON reads, safe error classification, live catalog parsing and request configuration between `ai_chat.rs` and `ai_model_check.rs`. OpenRouter discovery uses authenticated `GET /api/v1/models/user` (text candidates filtered by account preferences); `supported_parameters` supplies advertised tool support and explicit zero prompt/completion/request prices supply the Free label. NVIDIA discovery uses `GET /v1/models`, removing known non-chat task families; its discovery metadata does not establish tool support or account inference access. No catalog failure substitutes hardcoded models, and no arbitrary first-60 truncation hides catalog entries. Catalog responses are bounded to 3 MiB and 2,000 entries; candidate lists are not a guarantee of working inference.

Account status uses OpenRouter `GET /api/v1/key`, reporting only actual numeric per-key spending allowance, effective budget and free-model daily counters when present. NVIDIA account status says only whether the catalog is accessible, explicitly distinguishing discovery from successful inference. No raw key, account label, provider error body or echoed prompt is sent back to the UI. Shared error classification distinguishes 401, 402 balance/key/in-flight budgets, 403 workspace/guardrail policies, 429 quota/rate limits, 404 model/account/routing/tool availability, 410 retired models and transient server errors, including errors embedded in HTTP-200 streams. Retry-After seconds/HTTP-date headers (bounded to 24 hours) are enforced in memory across both editor windows; absent a 429 header, a conservative 60-second cooldown is used. These cooldowns do not reset or bypass provider quotas, and there are no automatic inference retries.

`AiChatState` spaces inference/check dispatch slots by 3.1 seconds per provider across windows and research rounds, and checks cooldowns again immediately before dispatch. All waits remain within the existing cancellable turn/check futures. OpenRouter research uses `provider.require_parameters=true` to avoid routes that discard tools. Both providers use `tool_choice=auto`, including synthetic checks, and require actual valid tool calls before a Research check passes. Unsupported models or policy routes fail explicitly. Default temperature/model-specific chat-template flags were removed; documented NVIDIA GPT-OSS endpoints receive `reasoning_effort=low`. Provider reasoning text/details are preserved only in memory for tool-result continuation, not displayed as answer text; OpenRouter reasoning_details chunks remain ordered. Existing bounded source tools and trusted project context are unchanged.

The panel provides a Free models only filter (blocking a paid/unknown selection until corrected), provider metadata labels, Account status and an adjustable 256–4096 response-token limit. The default response budget is 1,024 tokens; it is supplied explicitly to lower upfront reservations, and the Rust engine bounds direct callers to 64–8,192 tokens. Checks use the same streamed function-delta parser and shared request settings as real chat, and do not execute tool calls or send source files. Models advertised without tools can be marked unsupported for Research without spending an inference request. API checks still consume request quota/credits when sent; automated verification uses only synthetic responses.

Official references reviewed: OpenRouter [limits](https://openrouter.ai/docs/api_reference/limits), [errors](https://openrouter.ai/docs/api_reference/errors-and-debugging), [account-filtered models](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails), [routing parameters](https://openrouter.ai/docs/guides/routing/provider-selection), [reasoning continuation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens); NVIDIA [hosted chat APIs](https://docs.api.nvidia.com/nim/reference/llm-apis), [GPT-OSS endpoint](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer), and live public [model discovery](https://integrate.api.nvidia.com/v1/models). Documentation pages and discovery can differ as models are renamed/retired; runtime discovery takes precedence over documentation examples.

### Quick Editor refinement (source review only)
`EditorSurface` exposes a compartment-backed word-wrap toggle without recreating the editor. `AiFilePicker` browses folders on demand through existing `editor_list` and reads explicitly selected files through guarded `editor_export`; combined attachment limits and review-before-send remain enforced. `AiCode` reuses installed JavaScript/TypeScript, Python and JSON parsers for bounded response highlighting; other languages stay plain text. NVIDIA preferences are retained locally; automatic selection resolves a concrete model from the live catalog, with an optional explicit override. OpenRouter initial selection requires live free/tool metadata and a coding-family candidate; no paid fallback is selected. No runtime verification was performed.


### Persistent editor workspace and AI history (2026-10-28; source review only)

`chat_history.rs` owns trusted local chat persistence (not a model tool). Typed `chat_history_load` / `chat_history_save` store structured user/assistant messages, partial response status, draft, title and provider/model metadata. Writes require the editor writer lease, matching history revision and matching storage location. Writes use synchronized temporary files and atomic Windows replacement. Per-project limits are 100 chats / 8 MiB; exceeding limits reports an error and never prunes chats. Project IDs are byte-encoded into safe filenames. Hidden system prompts and credential controls are not serialized; message content uses existing sharing redaction before persistence.

Default directory: Tauri app-data `ai-chats-v1`. `chat_storage_location`, `chat_storage_pick`, and `chat_storage_apply` support a native selected empty custom directory, including available local drive folders. Migration copies and verifies project JSON before atomically updating the app-data location config; original history remains. Missing/unwritable directories report errors. Existing windows reject saves after a location change; Settings requests reopening DevFlow. Migration failures can leave copied files in the destination, requiring a fresh empty destination. The picker warns generally about Git/sync locations; automatic Git/sync detection is not implemented. `chat_history_export` exports one saved conversation via a native Markdown save dialog, refusing existing files.

QuickEditor keeps AI mounted while hidden. EditorSession optionally carries AI messages, draft, reviewed attachments, provider/model, visibility and width, plus folder expansion and logs layout. Active AI responses must be stopped before handoff/close. Pending history is flushed before normal handoff/clean close. History load/search/open/rename/delete/new-chat controls reuse the assistant panel; conversation switching clears attachments to require fresh review. Restart restoration uses redacted persisted messages/drafts; reviewed attachment snapshots remain memory-only.

`editor-preferences.ts` stores bounded preferences in localStorage and notifies both windows. EditorSurface reconfigures CodeMirror compartments for wrapping, font/line height, tab size, indentation unit, line numbers, active line and bracket matching without rebuilding editor state. Indentation guides are not implemented. Copy for AI offers selection/section/file scopes and 4/16/48 KiB/custom budgets (1–192 KiB); truncation preserves whole lines, reports warnings and uses existing Rust validation. Folder/tree export remains the existing guarded explorer action with its original limits.

Workspace metadata stores project identity/root, up to 20 tab paths, expanded folders and logs layout, never unsaved file text. Restart restoration validates files through guarded export and read APIs and skips unavailable/excluded paths. Nested file/folder creation validates every Windows path component and resolves each parent through existing Rust guards; missing parents require the explicit checkbox. Existing targets are never replaced. Source review only: no builds, checks, tests, launches or provider requests were run for this change.


## B1 — Lightweight API Tester (2026-10-28)

This section describes the local implementation, reviewed at source level only. No build, type check, Cargo check, automated tests, app launch, browser verification, or HTTP requests were run for B1.

### Modules and navigation

- `src/types.ts` adds `api` to the existing `View` union. `src/components.tsx` places **API Tester** between Logs and Quick Editor. `src/main.tsx` lazily mounts the workspace with the currently selected project; no router is added.
- `src/ApiTester.tsx` owns project-scoped draft state, request tabs, saved requests and collections, history, confirmations, local feedback, keyboard handling, and the response viewer. It provides its own project selector using the existing selection callback. Unmounting/project changes discard unsaved session inputs and cancel active requests; this policy is shown in the interface.
- `src/api-tester-api.ts` is the typed IPC boundary. `src/api-tester-state.ts` supplies request defaults, validation, session-only persistence projection, and configured service endpoint selection. It imports only domain types and has no service lifecycle behavior.
- `src/ApiTextEditor.tsx` uses the installed CodeMirror packages for JSON/text editing, inert read-only responses, search, and selection. Request editing is capped at 128 KiB. JSON syntax highlighting is limited to 128 KiB documents; larger responses remain readable and searchable without syntax parsing. `src/api-tester-format.worker.ts` formats JSON away from the UI thread, bounding depth, node count, and pretty-output expansion (2 MiB); excessive expansion falls back to raw text. `src/api-tester.css` uses the existing semantic light/dark tokens and responsive stacked layouts. Request area resizing uses native vertical CSS resizing.
- Service rows offer **Open in API Tester** when a configured loopback endpoint can be formed. The endpoint selector and shortcut use actual configured health/service host and port fields and a configured health path (or `/`). Missing hosts/ports and wildcard bind addresses are not guessed. The shortcut fills a new request without sending it or starting any service. Its small shared style lives in `src/style.css` so it is available before lazy loading the tester.
- Ctrl+Enter sends, Escape cancels an active request, and Ctrl+S saves only for events within the tester. CodeMirror retains response search behavior. Existing Quick Editor, Logs, notifications, AI research tools, snapshots, service control, and health-check contracts are unchanged.

### Native HTTP execution and IPC contracts

`src-tauri/src/api_tester.rs` reuses the existing `reqwest` dependency. `src-tauri/src/lib.rs` declares the module, manages `ApiTester`, registers all commands, and cancels tester work on main-window close/destruction and application exit. A main-targeted `api-tester-closing` event marks pending renderer reservations canceled even if the existing close-confirmation flow is routed to the floating editor. A native closed flag prevents late reservations after destruction. No dependencies, shell commands, scripts, processes, or HTTP servers are introduced by B1.

All new commands validate the native caller label as `main`. JavaScript argument/property names and nested serde DTOs use camelCase:

| Command | Frontend arguments | Result |
| --- | --- | --- |
| `api_tester_prepare` | `{ projectId, requestId }` | Reserves the single request slot and cancellation channel after validating the saved project. |
| `api_tester_send` | `{ projectId, requestId, request }` | `ApiOutcome`: kind, safe message, nullable status, statusLabel, durationMs, size, headers, body, truncated. |
| `api_tester_cancel` | `{ requestId }` | Cancels only the matching slot. Safe to repeat. |
| `api_tester_load` | `{ projectId }` | Versioned `ApiStore`. Missing files create an in-memory empty schema, not an automatic write. |
| `api_tester_save` | `{ projectId, store }` | Sanitized acknowledged store with incremented revision, after atomic replacement. |

Request fields: method, url, params, headers, bodyMode, body, form, bodySecret, auth, token, username, password, timeoutSeconds. Row fields: id, enabled, key, value, secret. Supported methods are GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS; bodies are none/JSON/text/form URL encoded; auth is none/Bearer/Basic/custom headers. Params append through the URL encoder, preserving the original URL query and duplicate names. JSON is validated before sending. Header parsing rejects malformed names/values, duplicate enabled headers, conflicting Content-Type, and user-controlled Host/framing/connection/proxy headers.

Only HTTP/HTTPS at `localhost`, `127.0.0.1`, or `[::1]` are accepted. URL credentials, fragments, whitespace/control characters, port zero, unsupported schemes, and other destinations are rejected. `localhost` resolution is pinned to IPv4/IPv6 literal loopback addresses; the client has proxies and redirects disabled, and the connected remote address is checked. Certificate verification is never disabled. The selected timeout is 1–120 seconds, including response consumption; connect timeout is at most 10 seconds. Serialized/encoded requests are bounded to 256 KiB, text bodies to 128 KiB, and each row table to 100 rows. Response headers are capped at 64 KiB and response bytes at 1 MiB; an oversized body is explicitly truncated and the stream dropped. Size reports retained bytes. Response content is UTF-8 text with replacement for invalid sequences; arbitrary binary rendering is not supported.

The backend selects the entire HTTP future against its cancellation receiver and overall timeout, dropping the future on cancellation/timeout. Prepare-before-send and the frontend canceled flag cover cancellation while reservation IPC is in flight. A matching ID/project is required for send; cleanup cannot remove a newer request's slot. Frontend ownership checks prevent results from an unmounted/project-switched tester from being shown. HTTP 4xx/5xx remain completed responses with their status, headers, and body; transport errors have controlled categories/messages and never stringify reqwest errors, which may contain URLs. No request or response is forwarded to Logs, notifications, incident reports, or AI.

### Persistence and credentials

Storage is `%APPDATA%\com.devflow.desktop\api-tester-v1\project-<hex-encoded-project-id>.json` via Tauri `app_data_dir()`, outside project source folders. Schema version 1 contains projectId, revision, requests, collections, history, and lastSelected. Each saved request has id/name/collection/request. History records timestamp/method/sanitized URL/durationMs/result and sanitized request configuration, never a response body. The effective history URL includes enabled parameter names with blank values.

Limits are 100 saved requests, 30 named collections, 30 recent requests, and 4 MiB per project file. Save/rename/duplicate/delete, collection assignment/create/delete (moving requests to Unfiled), name/URL filtering, reopen, last-selected persistence, history reopen, and confirmed history clearing are implemented. Saved request deletion is confirmed. History reopen does not send automatically and requires re-entering transient values.

Disk/project validation and storage work run through spawn_blocking rather than the Rust UI thread. Writes are serialized in the frontend and backend, with revision comparison, strict version/project/schema validation, unique saved IDs/collection names, and saved-project membership checks. Unsupported/corrupt files block saving rather than being silently repaired. Windows replacement uses a unique same-directory temporary file, sync_all, and MoveFileExW with REPLACE_EXISTING and WRITE_THROUGH; failure preserves the previous file and attempts to clean up the temporary file. Project IDs are byte-hex encoded to avoid filename/path collisions. No Git, cloud, export, or project-folder storage is involved.

Bearer tokens, Basic usernames/passwords, sensitive-name rows, secret-marked rows, and all header values in custom-header authorization mode are session only. New header rows default to session only. URL query values are always omitted from disk (keys and duplicates remain); nonsecret persistent query values belong in Params. Bodies default to session only; explicitly unchecking this permits nonsecret body persistence, with a further backend credential-field/marker scan that can omit it. This scan is conservative and cannot prove arbitrary strings are nonsecret: custom credentials must stay marked session only. History additionally removes every row value and body regardless of those preferences. Secrets are never saved to localStorage; there are no persistent credential references or Credential Manager entries because B1 credentials deliberately do not persist. In-memory auth fields/secret row values use masked input controls; no request-preview export exists.

### Verification still required

Source review covered imports, camelCase IPC shapes/registration, project bindings, cancellation/timeout cleanup, schema/loading/revision/atomic-write paths, session-only credential projection, response limits/formatting, UI handlers, shortcut scope, and theme tokens. Compilation, Windows networking/TLS/cancellation, create-send-inspect-save-reopen across restarts, project switching during requests, storage failures/conflicts, clipboard/search/large responses, and light/dark/narrow-window rendering still require verification. No compilation or runtime success is asserted.

## B2 — Port Manager

`src/PortManager.tsx` and `src/port-manager.css` provide the lazy `ports` navigation view, explicit inspect/refresh, project configuration context, derived counts, address-family/search/ownership filters, expandable process evidence, copy controls and the shared accessible confirmation dialog. No background scan, timer or project script parsing is added. Project changes reclassify the same local snapshot and dismiss pending confirmations.

`src-tauri/src/port_manager.rs` exposes typed `inspect_ports` and `stop_port_service` IPC. A blocking worker reads native `GetExtendedTcpTable` owner-PID **listener-only** tables for IPv4/IPv6, capped at three allocation attempts, 8 MiB and 16,384 rows per family. Per-PID process inspection uses query-only handles, image paths, creation times, liveness and membership of existing DevFlow Job Objects. A five-second cooperative budget bounds process-detail work (native calls already in progress cannot be cancelled). An atomic guard prevents concurrent scans; the UI discards results after unmount. Family failures are retained and never interpreted as availability. TCP tables and process details are separate point-in-time observations, not an atomic OS snapshot.

Only explicit `Service.port` and `Service.host` metadata drive diagnosis. Exact or IPv4 wildcard overlaps with a verified external owner are occupancy conflicts; unknown hosts, unavailable identity/membership and IPv6 wildcard dual-stack ambiguity remain potential conflicts. Duplicate port numbers alone are not conflicts. Unoccupied configured ports are described as no overlapping TCP listener observed, with a bind-time race caveat. No UDP or firewall reachability claims are made.

WindowsJob now supplies native membership queries and a monotonic per-run token. Port Manager stops only verified managed services: `stop_owned_service_checked` validates the run token under the existing registry lock before using the unchanged Job Object stop/reap path. Ordinary stop controls call the same path without a token and retain their behavior. Confirmation discloses whole-service/child-process impact. No unmanaged termination is exposed because user ownership plus development-process authorization cannot be established by the current contracts. No shell runner, escalation, dependencies or service controller is added; existing windows-sys native feature flags are enabled.

Native listener behavior, PID/access races, confirmation/stop behavior, clipboard, responsive layout and both themes still require manual runtime verification. No app launch or real termination test is implied by static checks.

## B3 — Developer Environment & Dependency Inspector

`src/DeveloperEnvironment.tsx` is a lazy main-window view near Projects. It uses the existing saved-project selection, shared Button/Card controls, and semantic theme variables. Results live only in React memory. All checks require a button action; project-switch and unmount generations discard stale results. Refresh All uses three frontend workers; there is no polling or cross-project scan.

`src-tauri/src/developer_environment.rs` owns two main-window-only IPC commands: `check_tool` accepts only a fixed tool ID and executes only its fixed `.exe` with a fixed version flag, with 4-second timeout, 4 KiB per output stream, hidden Windows window, no shell, and no stdin. PATH resolution excludes the working directory and batch shims; a `.cmd` shim is reported as Unknown without execution. Tool status describes executable discovery/version checks, never service health or installation everywhere on Windows. `check_project_requirements` validates the selected saved root through Quick Editor's existing linked-path guards and reads bounded root manifests through `spawn_blocking`. It recognizes package.json, requirements.txt, basic pyproject.toml declarations, Cargo.toml, and go.mod; lockfiles are presence notes only. Direct, safely readable `node_modules/<package>/package.json` versions can be compared with exact Node constraints. Other dependency installation and range compatibility remain Unknown. Complex constraints are omitted from output to avoid exposing credentials. No installer, build, project script, service start, file write, online lookup, or AI tool route is added.


## B1.1 - Explicit local API discovery

`src/api-discovery.ts` separates source discovery, OpenAPI 3.0/3.1 parsing, local reference resolution, and request preparation from transport. Explicit discovery inspects at most 16 allowlisted folders / 48 candidate files, 128 KiB per file and approximately 1 MiB total (the last bounded read may exceed the aggregate threshold). Existing directory listing and the main-window-only `api_tester_source` command reuse saved-root validation, reparse/ancestor guards and bounded text reads. No dependencies, execution, service starts, indexing or background scans are added.

`ApiTester.tsx` receives the existing running registry (excluding stopping services), shows configured loopback endpoints, and rechecks saved metadata and current running/stopping registries before OpenAPI discovery. Running means managed process presence, not socket readiness. Literal FastAPI constructor evidence supplies default/custom OpenAPI paths; disabled/dynamic paths are not guessed. An explicit path override is available. Fetches reuse the existing reservation/cancellation, eight-second timeout, 1 MiB response cap and redirect-blocked loopback transport. Schema server URLs and external references are ignored. Source patterns cover literal Express app routes and same-file router mounts, Flask app decorators, narrow Node method/URL comparisons and Python BaseHTTPRequestHandler path comparisons. Dynamic routes, cross-file mounts and unsupported patterns are omitted; source routes remain unverified.

`ApiExplorer.tsx` owns endpoint search, method filtering and collapsible groups. Selection prepares editable requests without sending. Parameters, schema/content type and bounded JSON examples are shown; unresolved path placeholders block sending. B1 saved requests, collections, history, session credentials, duplicate ordered query parameters and transport stay intact. Project-keyed remounts discard stale work; endpoint/status changes invalidate discovery; source cancellation is checked between reads. Response CodeMirror highlighting/search/copy gains a pointer/keyboard separator with a bounded size preference. Responsive styles reuse theme tokens. Windows rendering, actual local discovery and requests remain manual verification items.


## Overview command center

`src/Overview.tsx` and `src/overview.css` own the compact status strip, selected-workspace service panel, project-scoped tool shortcuts, project list, and bounded notification activity presentation. The project list filters locally between up to five recent selections, all running projects, and all projects with stopped-service failures; secondary project actions expand inline. App passes saved projects, existing local recent-selection ordering (no timestamps), the native managed-process registry, pending/stopping keys, service errors/exits, cached HTTP checks, and retained-log availability. Navigation selects the explicit target before changing views. Starts delegate to the existing guarded bulk runner and navigate to Projects for progress; no lifecycle implementation or IPC contract changes.

Overview subscribes only to the existing bounded NotificationStore, displaying event reason metadata without raw messages. Recorded/resolved history is separate from current stopped-service failure counts; stderr volume is never a failure count. Environment inspection reports only aggregate counts and completion time to App memory after explicit tool checks; Overview never mounts or triggers inspectors. API history, chat contents, endpoint discovery, port scans, and file scans are not loaded for Overview. No automatic probes, polling, provider requests, or new persistence are added. Both themes use existing semantic tokens. Native interactions and visual rendering require manual verification.


### AI attachment budgets
`ai-context.ts` owns UTF-8 accounting and the saved AI context preference: Small 16 KiB, Standard 64 KiB (default), Large 256 KiB, Extended 512 KiB. The Assistant Attach row and its Settings share this preference. Each reviewed attachment (including its metadata) is capped at 256 KiB, combined payloads at the selected budget, and outgoing message text at 1 MiB / 20 messages. Typed `context_budget` is allowlisted and enforced again by Rust. Complete safe history is retained until an explicit size/count rejection; attachments are never truncated. Serialized provider payloads including system/tool data are capped at 2 MiB each. Research retains its separate existing per-tool and cumulative transmission bounds. Provider token capacity remains separate from bytes; catalog capacity is displayed and provider failures remain visible without model substitution. Existing guarded 256 KiB file exports, bounded 2 MiB editor reads, root/reparse validation and secret checks remain unchanged. Selected logs no longer silently drop entries after the first 100; the attachment budget rejects oversized selections instead.


### Quick Editor local clipboard boundaries

`QuickEditor.tsx` and `editor-api.ts` route Explorer metadata (`name`, `relative`, `full`) through saved-root native validation without reading source contents. Full-path presentation removes canonical Windows drive/UNC prefixes only for clipboard display. `tree` walks metadata only, including binary/sensitive file names, prunes dependency/build folders, and never parses `.gitignore` or scans source contents. Traversal retains entry/depth/time/output and link guards.

Explicit raw file/selection/line/section copies use exact disk bytes or current CodeMirror text as appropriate, without provider-export credential checks or truncation. Explorer content uses disk; editor-originated actions retain unsaved drafts and never save them. Clearly sensitive filenames prompt about the local clipboard. Ctrl+C retains CodeMirror's standard local selection behavior. Markdown preview code-block copies remain plain local copies.

Clipboard-only `copy-file`, `copy-folder`, and `copy-slice` reuse `ai_chat::prepare_content` rather than the provider reject-only validator. Sensitive paths, ignored files, unsupported/binary types and uncertain private-key/multiline credentials remain excluded/blocked for AI preparation. Folder exports read disk, include complete fenced files, a tree, and explicit omitted paths/subtrees. Traversal is bounded to 2,000 entries, 100 included files, depth 24 and five seconds; individual reads retain the 2 MiB editor ceiling. Legacy attachment, validate, research and write policies retain their separate limits and behavior.

The persisted `devflow-editor-copy-budget` preference supports 16/64/128/256/512 KiB (64 KiB default). Native preparation and final frontend assembly check UTF-8 bytes including labels/fences. Oversize files are rejected or omitted whole; no excerpt is silently substituted. Users can increase the budget, narrow the folder, choose a file, or select code. This preference never changes Assistant or provider limits.

`CopyReview.tsx` displays only sanitized snapshots, affected project-relative paths/source lines, included-file count, omissions and exact bytes. Approval is bound to source, project, tab, draft, selection and budget; disk exports are prepared again and compared before copying. Failed clipboard writes do not report success. Both docked and floating windows mount this same workflow. No files, watchers, processes or network requests are created by copy. Redaction is heuristic; review before sharing.

### AI outgoing security and sanitization review

`ai_chat.rs::outgoing_content_issue` is the native policy for user text, history, attachments and assembled provider turns (including research/tool content). `ai_prepare_content` returns a bounded in-memory sanitization proposal and changed line numbers without returning detected values in diagnostics. Exact placeholders and direct environment references are permitted; an example/test field name does not exempt its value. Bearer prose is distinguished from header literals and opaque token-shaped values. Private-key markers and ambiguous multiline credential literals remain blocked. Delimited bearer/quoted assignment values retain surrounding text; uncertain single-line spans use a whole-line mask with line numbers preserved. Detection remains heuristic.

`editor_export` attachment mode retains saved-root, relative path, link/junction, ignore, type and sensitive-path guards; it checks disk even with a draft and returns only the sanitized snapshot (256 KiB cap). Existing validate/copy/research/write policies retain their fail-closed behavior. No file is modified by sanitization. `ai-context.ts` applies path/size guards to native-prepared snapshots; the panel validates them with the native policy again before request assembly. `ai-api.ts` bounds its session cache to 16 unchanged safe inputs; changed/rejected content is evicted. The panel binds message review to exact original/sanitized content and current send inputs, invalidates draft/attachment approvals on edits, excludes failed user/assistant turns and natively unsafe history, and never substitutes an original after review. Attachment previews identify sanitized source/context lines and retain removal controls. Final native request validation remains mandatory; each assembled provider turn is checked again before transmission. No AI file writes or command execution is introduced.


## Documentation maintenance and verification

`AGENTS.md` holds shared coding policy and check commands; `CLAUDE.md` points Claude to that policy. This document maps current implementation. `docs/DESIGN_SYSTEM.md` governs UI patterns; `docs/QUICK_EDITOR.md`, `docs/DOCKABLE_LOGS.md`, `docs/NOTIFICATIONS.md`, and `docs/SYSTEM_CENTER.md` provide focused background. Old roadmap/phase labels are not runtime evidence.

For changes, inspect the relevant source, IPC registration, wrappers, window authorization and tests together. Update this reference when ownership, contracts or persistence change, and update `guide-content.ts` when user workflows change. There is no MCP server, automatic dependency installer or automatic venv setup in the current registered implementation.

This update checks documented paths and command coverage against local files and checks Markdown diffs. It does not run builds or tests. Outstanding acceptance includes real Windows import/save/reopen, reliable contained start/stop/restart/shutdown, second-workspace reopening, floating-window/draft recovery, clipboard, provider/account behavior, and visual/keyboard checks. Native cleanup and End Task must be tested only against deliberately authorized disposable targets.
