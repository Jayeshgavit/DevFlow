# DevFlow design system

DevFlow is a local development workspace manager. The interface gives project commands, service state, and logs priority. It does not present simulated analytics or editor controls.

## Themes and color roles

Theme values live in `src/style.css` as CSS custom properties. Components use semantic variables (`--surface`, `--text`, `--border-soft`, `--success`, `--danger`, `--focus`) so both themes stay aligned. The saved setting is `light`, `dark`, or `system`; `system` follows the operating system preference.

| Role | Light | Dark |
| --- | --- | --- |
| Background | `#F6F5F1` | `#111216` |
| Primary surface | `#FFFFFF` | `#1B1D24` |
| Elevated surface | `#FFFFFF` | `#22252E` |
| Primary text | `#14213D` | `#EDF0F7` |
| Secondary text | `#516078` | `#B3BAC9` |
| Border anchor | `#14213D` | `#505769` |
| Main accent | Blue `#91B2FA` | Violet `#6558FF` |
| Secondary accent | Lavender `#C7A6F5` | Orange `#FF842B` |
| Positive accent | Mint `#61C99A` | Green `#13D99B` |

Light uses outlined white panels on warm paper. Dark uses restrained charcoal layers; bright accents mark actions and real status, not decoration. Status colors and focus rings have their own semantic tokens.

## Typography

- **Headings:** Space Grotesk, weights 500–700.
- **Interface:** Inter, weights 400–700.
- **Commands and logs:** JetBrains Mono, weights 400–500.

Fonts are bundled through project-local `@fontsource` packages. No runtime Google Fonts request is used. Interface copy is compact and direct; paths and output can wrap or scroll without hiding essential data.

## Spacing and shape

Use the 4 px spacing scale: `--space-1` through `--space-10` (4, 8, 12, 16, 20, 24, 32, 40 px). Control radii are 6 or 10 px; cards use 14 px; confirmation dialogs use 18 px. Maintain clear separation between navigation, project configuration, and output.

## Components and interactions

- **Sidebar:** workspace views plus System Monitor and Maintenance, project selection, import, and a theme shortcut. Selected view has a persistent label and focus state.
- **Button and Card:** shared primitives with primary, secondary, quiet, and danger button styles. Disabled means unavailable; it does not imply success.
- **Status:** derived from Rust's current running registry, with a local error state after a failed start. It does not claim port readiness.
- **Service row:** editable name, directory, executable, and one argument per line; start, forced stop, restart, and removal actions. Forced termination has a confirmation dialog.
- **Log viewer:** combined and service tabs, deferred text search, severity and stream filters, next/previous error and warning navigation, copy, export, and clear matching output. Timestamps use 24-hour time with full dates in tooltips. Stderr and system lines have distinct treatments; severity is determined by content and HTTP status, not stream alone.
- **Log blocks:** contiguous Python tracebacks and common JavaScript/Java stack frames can collapse together, within the same project, service, and stream. Unrecognized formats remain individual entries. Raw logs remain the source of truth. Copying an error retains the existing nearby context and best-effort redaction.
- **Log console:** compact project header, service/search/follow toolbar, and secondary options and copy/export/clear menus. Saved font size (10–22 px) and line wrapping use local preferences. Copy supports selection, individual lines/blocks, viewport output, all retained project output, service-role/error subsets, nearby context, and the AI debug prompt. Text search is reachable with Ctrl+F in Logs.
- **Log performance:** continuous scrolling uses measured virtual rows with overscan for wrapped output and expanded stacks. Counters, search, filtered copy/export, and clear operate across the entire matching buffer. Entry classification and search text remain cached by entry identity; formatting for export runs on demand. History is bounded to 10,000 entries per service, 20,000 per project, and 40,000 per session.
- **Following:** pause when scrolling away from the bottom, changing filters, or navigating issues. Jump to latest or Follow latest returns to new output. Paused scrolling anchors to entry identity and restores per-filter bookmarks (up to 80); if retention removes the anchor, use the next retained timestamp. The Logs viewer stays mounted across app tabs so filters, stack expansion, and scroll position remain available. Retention caps still apply while paused.
- **Empty, loading, and error states:** explain the next useful action without invented activity.
- **Settings:** saved theme and compact density preferences in local storage. Project definitions remain in the existing Tauri app-config JSON.
- **System Monitor:** measured CPU and RAM with a 30-sample history, fixed local drive capacities, uptime, and a sortable process table. Unavailable samples remain gaps. Tables render at most 100 processes per page and retain scroll/sort/search across refreshes. High utilization suggests investigation rather than a health score. GPU telemetry is explicitly unavailable.
- **Maintenance:** separate scan, file preview/selection, confirmation, busy/cancel, and results states. Permanent deletion and End Task use the shared confirmation dialog. Results persist while navigating within DevFlow; polling stops outside system views. Show risk, scope, age threshold, skipped items, and actual removed file lengths. See `docs/SYSTEM_CENTER.md` for the command boundaries and release limitations.

## Quick Editor

Quick Editor is a compact file-reading and editing surface for AI chat workflows. It reuses the semantic theme tokens, Inter controls, and JetBrains Mono code. The 260 px explorer resizes from 180–400 px within the available window space, collapses, and remembers its width. Project folders load only when opened; the editor and language packages load on demand.

Code opens read-only; Markdown opens in a rendered preview with raw HTML and unsafe URLs disabled. Remote images are represented by their alt text. The same CodeMirror surface retains selection and undo history across view/edit toggles. The section outline is best effort, with search and go-to-line available for precise navigation. Copy for AI includes the relative path, actual line range, and a safe code fence.

Only existing UTF-8 text files up to 2 MiB inside saved project roots are supported. Linked paths and junctions are blocked; mixed line endings and filesystem read-only files stay view-only. Saving checks for external edits, preserves BOM and line endings, and snapshots the previous on-disk bytes in DevFlow local app data before replacement. History provides preview, a side-by-side comparison with a fresh local disk read, and confirmed restore. Retention is bounded to 20 versions per file, 999 records and 64 MiB overall; sensitive/excluded files have no history. Temporary replacement files beside the original are removed on success; failed or concurrent replacements can leave a clearly reported recovery file. Drafts remain in memory across app navigation and file tabs, with discard protection when closing dirty tabs, changing editor projects, reloading disk content, or closing the docked window. Float/Dock transfers the session through Rust memory; closing the floating window docks its drafts. See `QUICK_EDITOR.md` for handoff behavior, limits, and manual verification.

## Accessibility and responsive behavior

Use native buttons and labelled inputs. Keyboard focus uses `--focus`; dialogs focus Cancel and close with Escape. Controls remain usable at the configured 850 px minimum Tauri window width, while narrower CSS breakpoints collapse the sidebar to icons and stack service fields. Motion is short and disabled under `prefers-reduced-motion`.

## Visual principles

### Overview

The selected workspace anchors the page with its actual service state, HTTP check timestamps, session-log availability and existing project actions. A single ruled status strip summarizes saved projects, managed services, reported failures and the last completed environment check. Recent, Running and Needs attention filter the project list; secondary per-project actions expand inline under Project tools. Tools and recorded activity form a quieter side column that stacks below project work at narrower widths.

Overview uses the existing UI type family, neutral surfaces and semantic status colors. A restrained blue surface distinguishes the selected workspace, mint indicates managed running state, and amber marks recorded activity. Long project names and paths wrap; controls have visible keyboard focus, disabled-start explanations and 44 px touch targets at narrow widths. No decorative metrics, background probes or additional process collectors are introduced.

### Logs workspace

The shared Logs viewer adapts to its own container width. Its primary toolbar keeps service selection, search, visual following, Copy, and More accessible. Process controls expand explicitly; display/stream settings and history limits live under More. Docked and floating viewers share the existing projected log stream and use a single output scroll container. Jump to latest occupies a separate rail below the output and appears only when the viewport is away from its end. Resizing retains measured row heights unless the output width changes.

Search navigation counts matching blocks; severity counts describe retained lines rather than independent process crashes. Copy visible blocks includes complete contents of intersecting blocks, including collapsed lines; filtered export uses the matching buffered entries in chronological order.

Display and Copy/Export use the same best-effort masking for recognized credential fields, Basic/Bearer authorization, cookie headers, and URL/connection-string credentials. Raw buffered data remains available to the existing internal classification and grouping pipeline. Unrecognized/custom secrets and cross-line credential fragments may remain: review output before sharing. Output remains inert React text; only validated, user-initiated local links and project-file actions are offered.

Keep project work and logs immediately visible. Use large headings sparingly, dense but readable service panels, and accent color for meaning. Do not add fake resource charts, decorative dashboards, broad neon glows, or controls without a real action. Preserve typed Tauri IPC names and event contracts when changing presentation.
