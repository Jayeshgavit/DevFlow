# Notifications

`src/notifications.ts` is the typed, single-writer incident store. It consumes verified lifecycle results, typed Rust diagnostics, distinct health samples and explicit application/save failures. It never observes arbitrary stdout/stderr content or infers hangs from silence.

Service failures within five minutes share an incident ID: a health failure or explicit address-in-use diagnostic followed by an exit updates that incident rather than creating another alert. Occurrences count correlated failure signals, not process restarts. Identical application/save/collection errors group; unrelated messages remain separate. Three unhealthy probes spanning at least 15 seconds are required after the existing startup grace. Healthy endpoint results resolve prior service failures and record recovery. Successful process launch alone does not claim endpoint recovery. Intentional exits do not generate crash alerts; successful requested starts/stops record quiet activity.

The store retains up to 300 incidents for 30 days, with redacted messages, stable UUIDs, project/service IDs, first/latest timestamps, occurrence count, read state, resolution and a system-log reference. History and preferences use versioned local storage, matching existing UI preference persistence. Writes debounce for 400 ms and flush on page hide. Storage failures leave history usable in memory and expose an in-app status. Raw service logs remain session-only. Abrupt termination can lose the last debounced write.

New incidents and changed diagnostic details append labeled `DevFlow` system events through the existing bounded log buffer. Repeated identical signals update the center without flooding Logs. Incident navigation selects the exact project/service, clears filters, pauses following and targets the system event in the existing measured virtual viewport. If retention or a prior session removed the event, navigation restores its persisted summary; this does not restore raw process output. Global application incidents are visible alongside project output and in Logs with no configured project. Removed projects are reported as unavailable.

The bell and center subscribe to the incident store, independently of high-volume raw log processing. The center supports keyboard focus trapping, Escape dismissal, mark-read and clear-read controls. Toasts use a polite live region, auto-dismiss after 6.5 seconds and respect quiet mode. Animation uses only opacity/transform and is disabled under reduced motion. Routine activity never generates toasts or desktop alerts, even when enabled for unread history.

Interruptions are limited to three per minute, with a 30-second cooldown per project/service and separate failure/recovery buckets. Quiet mode suppresses interruptions while retaining events. Recovery toasts have a separate preference. Desktop alerts are opt-in and limited to important failures. Native delivery failures suspend desktop attempts for the session until Desktop alerts is toggled; history and in-app alerts continue.

The Rust `tauri-plugin-notification` 2.7 API sends generic lock-screen text plus an opaque incident ID. Desktop click callbacks reveal/focus the existing main window and route that ID to the in-app incident navigation. No arbitrary notification bodies or shell execution are exposed over IPC. Rust additionally limits native dispatch frequency. Callbacks exist only for this running application; there is no background daemon or updater. The plugin's `show()` can report preparation errors but dispatches asynchronously, so it cannot reliably report OS suppression or prove that Windows displayed a toast. Windows Focus Assist and notification settings remain authoritative.

## Verification

Focused store tests cover intentional stop versus unexpected exit, failed starts/restart grouping, distinct sustained health failures/recovery, port/exit correlation, quiet/routine/recovery preferences, rate limits, history bounds and reload, redaction, navigation destination/reference selection, malformed storage and simulated native API failure. Rust tests check that only explicit address-in-use diagnostics qualify. Existing lifecycle tests exercise Windows process containment and cleanup.

Manual desktop verification remains necessary for center/toast rendering in both themes, keyboard focus and repeated click-to-log scrolling, real endpoint degradation/recovery, Windows toast appearance/clicks and OS-disabled alerts. No installer build is required by this change.

Commands run on Windows:

- `node node_modules/typescript/bin/tsc --noEmit` — passed.
- `node tests/notifications.test.mjs` — notification store scenarios passed.
- `node tests/log-utils.test.mjs` — 9 passed.
- `cargo check --manifest-path src-tauri/Cargo.toml` — passed after the notification dependency was downloaded using `--config net.offline=false`.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib notifications::tests -- --nocapture` — 1 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib lifecycle_tests -- --nocapture` — 6 passed, including Windows descendant cleanup.
- `git diff --check` — passed; Git reported line-ending conversion warnings only.
