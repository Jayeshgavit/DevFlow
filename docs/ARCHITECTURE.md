# DevFlow architecture and codebase reference

Verified against current local source files, including uncommitted local edits, on 2026-10-27. All paths are repository-relative. This document serves as the permanent, accurate reference for DevFlow architecture, wiring, and module responsibilities. No builds, tests, Git history, or remote sources were used for this update.

---

## 1. Tech stack

| Layer | Actual dependencies / implementation |
| --- | --- |
| **Desktop framework** | Tauri 2 (`@tauri-apps/api` ^2.0.0, `@tauri-apps/plugin-dialog` ^2.0.0, `tauri` 2, `tauri-plugin-dialog` 2, `tauri-plugin-notification` 2.7) |
| **Frontend UI** | React 18.3.1, TypeScript 5.6.0 (strict), Vite 6.0.0, Lucide React ^0.468.0, standard CSS modules/stylesheets |
| **Quick Editor** | CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`, `@lezer/highlight`), lazy syntax modes (`lang-javascript`, `lang-python`, `lang-json`, `lang-html`, `lang-css`, `lang-markdown`), Markdown preview (`react-markdown` ^10.1.0, `remark-gfm` ^4.0.1) |
| **Typography** | Local `@fontsource/inter`, `@fontsource/space-grotesk`, `@fontsource/jetbrains-mono` |
| **Backend core** | Rust 2021 edition, `tokio` 1 (features: `process`, `io-util`, `sync`, `time`, `net`), `serde` 1 + `serde_json` 1, `ignore` 0.4 (directory walking & export filters) |
| **Windows native** | `windows-sys` 0.61.2 (Win32 APIs: Job Objects, processes, threads, Toolhelp, memory, performance, filesystem, COM, shell, messaging), `windows` 0.62.2 (`Win32_Graphics_Dxgi`) |
| **Persistence** | Local JSON configuration (`projects.json`) and snapshot records (`file-snapshots-v1`); WebView `localStorage` for UI preferences. No hosted backend, cloud account, or remote telemetry. |

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
- **Routing & Views**: No external router library. Navigation uses a typed `View` state union (`overview | projects | logs | editor | system | maintenance | settings`). Secondary windows (`quick-editor`, `logs-*`) load `index.html` with query parameters (`?window=quick-editor`, `?window=logs&project=...`) and mount specialized views (`FloatingEditor`, `FloatingLogs`).
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
| `src/log-utils.ts` | Pure log engine: `appendLogs`, `logBytes` (caps: 10K lines/8MB per service, 20K lines/16MB per project, 40K lines/32MB per session), `createSourceDeduper`, `createAnsiLogNormalizer`, `groupLogs`, `redactForSharing`, `parseErrorLocation`, `buildAiDebugPrompt`. | `src/main.tsx`, `src/SharedLogs.tsx`, `src/components.tsx` | Retention caps, ANSI parsing, secret redaction patterns, stack trace parsing |
| `src/log-actions.ts` | Frontend log action helpers: `writeLogClipboard` (`logs_copy`), `exportLogText` (`logs_export`), `verifyErrorLocation`, `openErrorLocation`. | `src-tauri/src/log_actions.rs`, `src/components.tsx` | Clipboard and file export caller logic |
| `src-tauri/src/log_actions.rs` | Native log actions: `logs_copy` (Win32 clipboard), `logs_export` (Tauri file save dialog), `logs_verify_location`, `logs_open_location`, `logs_take_location`. | `src/log-actions.ts`, `src-tauri/src/logs_window.rs` | Native clipboard integration, export dialog, file/line jump routing |
| `src/components.tsx` (`LogViewer`) | `LogViewer`: Virtualized log console, level filters, service filters, text search, follow mode, ANSI rendering, error-location links. | `src/log-viewport.tsx`, `src/log-console.css` | Log console UI, search highlighting, filter tabs |
| `src/log-viewport.tsx` | `LogViewport`: High-performance measured row virtualizer for smooth rendering of thousands of log entries. | `src/components.tsx` | Virtual scroll measurement, row height calculation |
| `src/SharedLogs.tsx` | Log sharing: `LogsContext`, `useLogsBridge`, `ProjectLogs`, `FloatingLogs`, `floatLogs`. Synchronizes log frames across windows. | `src/log-sharing.ts`, `src-tauri/src/logs_window.rs` | Cross-window log synchronization protocol |
| `src/log-sharing.ts` | `createLogFrames`, `applyLogFrame`: Computes incremental delta frames and resets for multi-window log mirroring. | `src/SharedLogs.tsx` | Frame delta computation, sequence reconciliation |

### 3.6 Quick Editor and file explorer
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/QuickEditor.tsx` | Quick Editor shell: File tree explorer, multi-tab management, dirty state tracking, line ending preservation, save/reload, file creation/rename, error location jump. | `src/EditorSurface.tsx`, `src/EditorContextMenu.tsx`, `src/EditorHistory.tsx`, `src/editor-api.ts` | Editor layout, tab management, file tree interactions |
| `src/EditorSurface.tsx` | CodeMirror 6 integration: Lazy language extension loading, theme styling, scroll syncing, text selection API, Markdown live preview toggle. | `src/QuickEditor.tsx`, CodeMirror packages | Code editor keymaps, extensions, code highlighting |
| `src/editor-api.ts` | Typed IPC wrapper: `editorApi` (`list`, `read`, `save`, `mutate`, `export`, `reveal`, `lease`, `history`, `snapshot`, `restore`). Text normalization and `aiContext` builder. | `src-tauri/src/quick_editor.rs`, `src-tauri/src/quick_editor/actions.rs` | Editor IPC contracts, AI context snippet generation |
| `src/editor-session.ts` | Pure session helpers: `openTab`, `closeTab`, `updateDraft`, `renameTab`, `dirtyTabs`. | `src/QuickEditor.tsx`, `tests/editor-session.test.mjs` | Tab state transitions, dirty tracking logic |
| `src/EditorContextMenu.tsx` | Context menus for file tree and editor tabs: New file, new folder, rename, reveal in Explorer, export context. | `src/QuickEditor.tsx`, `src/quick-editor.css` | Tree context menu actions |
| `src-tauri/src/quick_editor.rs` | Native file engine: `editor_list`, `editor_read`, `editor_save`. Restricts access strictly to saved project roots. Guards against path traversal, symlinks, junctions, reparse points (`guard_directories`). Max file size 2 MiB. | `src-tauri/src/quick_editor/actions.rs`, `src-tauri/src/quick_editor/snapshots.rs` | File security validation, filesystem I/O constraints |
| `src-tauri/src/quick_editor/actions.rs` | Native editor actions: `editor_export` (reads file/folder/tree with exclusions), `editor_mutate` (create file/folder, rename), `editor_reveal` (Explorer select). | `src-tauri/src/quick_editor.rs` | Export exclusions, file creation/rename security rules |

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
| `src-tauri/src/quick_editor/snapshots.rs` | Snapshot engine: `before_save`, `editor_history`, `editor_snapshot`, `editor_restore`. Automatic snapshot before save. Enforces 20 versions/file, 1000 total records, 64 MiB total storage cap. Sensitive content and excluded files are skipped. | `src-tauri/src/quick_editor.rs` | Snapshot pruning rules, sensitive content filters, restore validation |

### 3.9 Settings and local persistence
| File path | Responsibility & key symbols | Connected modules | Where changes start |
| --- | --- | --- | --- |
| `src/main.tsx` (Settings view) | Appearance preferences (theme: light/dark/system, compact layout switch), keyboard shortcuts reference, local design information. | `src/components.tsx`, `localStorage` | Adding application settings or appearance toggles |
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
| | `shutdown_app` | `confirmed: bool` | `()` | Gracefully stops all owned services and exits application. |
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
| **External** | `open_directory` | `path: String, mode: String` | `()` | Opens directory in Explorer or preferred terminal. |
| | `open_in_ai_cli` | `root: String` | `()` | Launches user-configured AI CLI in project root. |

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

### Managed backend state & Window labels

- **`AppState`**: Holds in-memory map of `ProcessEntry` (`Starting`, `Running`, `Stopping`), `exiting` atomic flag, and `projects_loaded` status.
- **`WindowsJob`**: Encapsulates Windows Job Object handle for each running service tree.
- **`QuickEditor`**: File access synchronization mutex.
- **`EditorWindow`**: Manages editor handoff `Session` (`owner`, `snapshot`, `revision`).
- **`LogsWindows`**: Tracks floating log windows, pending docks, and target navigation locations.
- **`DesktopAlerts`**: Throttles native Windows notifications (10-second interval).
- **`SystemCenter`**: Caches system performance queries and maintenance cancellation tokens.
- **Window labels**:
  - `main`: Primary application shell.
  - `quick-editor`: Standalone floating editor window (`?window=quick-editor`).
  - `logs-<hex>`: Floating logs window (`?window=logs&project=logs-<hex>`), where `<hex>` is the lowercase hex-encoded UTF-8 project ID.

---

## 5. Data and storage

| Data category | Storage location & lifetime | Format / Limits | Persistence mechanism |
| --- | --- | --- | --- |
| **Project configurations** | `%APPDATA%\com.devflow.desktop\projects.json` | JSON format. Validated schema: unique IDs, absolute roots, sanitized program names. | Persistent. Saved atomically via `save_file` (`projects.<id>.tmp` -> `projects.json`). Leaves `projects.previous.<id>.json` on replace. |
| **File snapshots** | `%LOCALAPPDATA%\com.devflow.desktop\file-snapshots-v1\` | JSON records: `{ id, timestamp, project, file, path, content }`. | Persistent across sessions. Bounded: 20 versions/file, 1000 total records, 64 MiB total store. Oldest pruned automatically. |
| **Active project files** | User workspace directories on disk | Raw source files (UTF-8). Max size 2 MiB in Quick Editor. | Direct filesystem writes with temporary staging (`.devflow-*.tmp`) and `.bak` fallback. |
| **UI preferences** | Chromium WebView `localStorage` | Key-value pairs: `devflow-theme`, `devflow-compact`, `devflow-recent`, `devflow-sidebar-collapsed`, `devflow-editor-width`, etc. | Managed by WebView2 runtime on local machine. |
| **Incident history** | Chromium WebView `localStorage` (`devflow-notifications-v1`) | JSON format. Capped at 300 records and 30-day age limit. | Persistent. Managed by `NotificationStore`. |
| **Service output logs** | In-memory only (`src/main.tsx` React state) | Bounded log buffers: 10,000 lines / 8 MB per service; 20,000 lines / 16 MB per project; 40,000 lines / 32 MB per session. | Ephemeral. Cleared when application closes. Exportable to disk via user action. |
| **Process handles & Jobs** | In-memory only (`AppState` in Rust backend) | Tokio `Child` handles and Win32 Job Object handles. | Ephemeral. All processes terminated and Jobs closed on application exit. |
| **Editor drafts** | In-memory only (`QuickEditor` React state & `EditorWindow` handoff) | Unsaved tab drafts and revision leases. | Ephemeral. Unsaved drafts prompt user before close; no silent discard. |

---

## 6. Safety rules

1. **Managed process containment**: Every service is launched in a dedicated Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Process termination terminates the entire process tree, preventing orphaned descendant processes. Never kill processes by PID discovery, executable name, or port binding.
2. **Safe file access**: Quick Editor operations strictly require path validation inside saved project roots. Rejects directory traversal (`..`), path separators in components, colon streams (`:`), NUL bytes, symlinks, NTFS junctions, and reparse points. Ancestor directories are held with non-delete-sharing handles during writes to prevent junction swapping.
3. **Draft preservation & writer leases**: Editor file writes require a valid writer revision lease. Floating and docked windows transfer ownership through an explicit handoff protocol. Window close events check for dirty drafts and require confirmation before discarding.
4. **Secret handling & redaction**: Never save credentials or secrets in project configurations. Export routines and AI prompts run through `redactForSharing()` (masking API keys, tokens, auth headers, passwords, connection strings). Raw logs remain local and are never transmitted automatically.
5. **Bounded resource allocation**: Output collection is rate-limited and chunked (16 KiB chunks, 50 ms flush). Service logs have strict line and byte caps. Snapshot storage is capped at 64 MiB. Large files (>2 MiB) are blocked from Quick Editor.
6. **No arbitrary shell execution**: Service execution requires explicit program and argument lists reviewed by the user. Constrained batch scripts run via dedicated wrappers; arbitrary unrestricted shell commands or silent installs are prohibited.

---

## 7. Feature status

| Feature area | Implementation status | Evidence in codebase |
| --- | --- | --- |
| **Project import & detection** | **Implemented** | Heuristic detection for Node.js (npm/yarn/pnpm), Rust (Cargo), and Python (FastAPI/Flask/Django/uvicorn). Manual configuration overrides supported. |
| **Service lifecycle** | **Implemented** | Start, stop, restart, bulk actions, and graceful shutdown backed by Windows Job Objects. Port conflict detection and reservation tracking. |
| **Loopback health checks** | **Implemented** | Configurable HTTP health checks restricted to loopback (`127.0.0.1`/`::1`) with status code ranges. |
| **Health dashboard** | **Present, unintegrated** | `src/service-health-dashboard.tsx` is implemented but not currently routed or mounted in `src/main.tsx`. |
| **Log viewing & filtering** | **Implemented** | Virtualized log viewer (`LogViewport`), ANSI color rendering, search, level filters, service filters, HTTP request parsing. |
| **Native clipboard & export** | **Implemented** | Native Win32 clipboard copy (`logs_copy`), file export dialog (`logs_export`), stack trace file:line location jump. |
| **Quick Editor** | **Implemented** | Multi-tab editor with CodeMirror 6, lazy language syntax, live Markdown preview, file tree explorer, atomic save. |
| **Floating/docked windows** | **Implemented** | Floating editor and per-project floating logs windows with clean lease-based handoff and docking protocols. |
| **File snapshot history** | **Implemented** | Pre-save snapshot engine with diff comparison and conflict-guarded restore (`file-snapshots-v1`). |
| **System Center** | **Implemented (Windows)** | System telemetry (CPU, RAM, GPU, Disks), process inspector with safe End Task, temp file cleaner, DNS flush. Non-Windows platforms use fallback stub. |
| **Incident notifications** | **Implemented** | In-app notification center with deduplication, severity levels, and throttled native Windows desktop toasts. |
| **A3 AI Chat / Assistant** | **Planned / Future** | Not implemented. CLI shortcuts (`open_in_ai_cli`) and prompt context exporters (`buildAiDebugPrompt`, `editor_export`) exist, but no embedded chat runtime. |
| **Runtime certification** | **Unverified in this task** | Verification is based on static source analysis and structure. No builds, test runs, or native OS executions were performed during this documentation update. |

---

## 8. Future AI development: A3 read-only AI Chat

When implementing A3 read-only AI Chat in future sessions:

1. **Architecture & placement**:
   - Add a dedicated view (`chat`) in `src/types.ts` and mount an isolated interface in `src/main.tsx`.
   - Reuse existing design tokens, components (`Card`, `Button`, `Status`), and theme styles from `docs/DESIGN_SYSTEM.md`.
2. **Backend IPC contracts**:
   - Keep AI provider communication strictly inside Rust (`src-tauri`), never exposing API keys, network fetch logic, or raw tokens to the frontend.
   - Register explicit, typed Tauri commands in `src-tauri/src/lib.rs` (e.g., `ai_chat_send`, `ai_chat_cancel`, `ai_chat_clear`).
3. **Context adapters & safety**:
   - Expose read-only context adapters: project metadata, reviewed service commands, sanitized logs (via `redactForSharing`), and selected file slices (via `editor_export` / `aiContext`).
   - Chat must be **read-only**: do not grant chat the ability to start/stop services, mutate files, restore snapshots, run arbitrary shell commands, or delete cleanup categories.
4. **Isolation**:
   - Maintain conversation history in memory or isolated local storage; do not mix chat state with `ProjectStore`, writer leases, or service process state.
   - Update this reference document whenever new commands, events, or modules are introduced.
