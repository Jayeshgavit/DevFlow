# Quick Editor clipboard audit

Reviewed against current local source including existing uncommitted work. This is source evidence; desktop behavior remains unverified.

| Entry point | Source and validation | Clipboard and feedback |
| --- | --- | --- |
| Explorer Copy File/Folder Name | `copyMetadata` -> typed `editor_export` name; saved project/root and unlinked target, no content read | Exact on-disk basename; awaited write then success |
| Explorer / toolbar / editor menu Copy Relative Path | Same native metadata boundary, relative mode | Project-relative path or `.`; awaited write |
| Explorer Copy Full Path | Same metadata boundary, full mode | Readable Windows drive/UNC path; canonical security identity retained |
| Explorer Copy Entire File Content | `editor_read`, trusted root/link/UTF-8/2 MiB guards | Exact disk content, sensitive-source warning, no credential scan |
| Explorer Copy File for AI | `copy-file`, disk source, exclusions/ignore/type/read guards, shared sanitizer | Path/language and collision-safe fence, complete content, budget enforcement; sanitization review |
| Explorer Copy Folder Tree | `tree`, metadata-only bounded traversal, no `.gitignore` or content reads | Names only, including binary and sensitive filenames; build/dependency subtrees pruned; limit warnings |
| Explorer Copy Folder for AI | `copy-folder`, selected disk subtree, bounded traversal, shared sanitizer | Complete fenced files, tree, omitted paths/subtrees, budget enforcement and sanitization review |
| Copy dropdown / editor menu Copy Current File | Current unsaved draft or exact cached disk content | Raw local text, no AI checks or truncation; sensitive-source warning |
| Copy dropdown / editor menu Copy Selection | Actual CodeMirror main selection | Exact selected text; empty/unavailable scopes disabled; no fallback to entire Markdown file |
| Copy dropdown Current line / line range | CodeMirror slice, line boundaries | Complete selected lines as raw text |
| Copy dropdown Current code section | Existing foldable section / nonblank-block slice | Raw complete section; best-effort syntax scope retained |
| Toolbar Copy for AI source selector | Current file, actual selected code or enclosing section; native `copy-slice` checks eligible project file and sanitizes only requested draft scope | Relative path, source kind, accurate source line range, fence; assembled UTF-8 budget includes headers |
| Editor menu Copy Selection for AI | Same selected-code preparation | Same sanitized review/budget and stale-input protection |
| Markdown preview code-block Copy | Rendered code-node text | Raw local clipboard through shared feedback/error path |
| Ctrl+C / Ctrl+X | Existing CodeMirror local selection commands | Standard editor behavior retained; no provider request or AI export filter |
| Native/DOM text selection | Browser/WebView local clipboard behavior | No custom AI policy introduced |

Menus close when an action is invoked. Context menu retains dismissal, focus restoration, keyboard navigation and disabled link entries. Copy toolbar retains its existing dismissal. Awaited application clipboard writes show success only after resolution. Provider rejection policies, Assistant attachment preparation, editor ownership leases, saves/snapshots, Smart Replace and file creation remain separate.

Sanitized review contains no original sensitive text. It displays changed source lines, safe text, included count and bytes; omitted paths appear in folder payload. Project/tab/draft/selection/budget/ownership changes invalidate review. Confirmation re-prepares disk sources and compares exact safe payload and warnings. Fail-closed errors never include detected values.

No all-tabs export or partial-excerpt action was offered by the existing UI, and neither has been invented. Use selected code for an explicit smaller excerpt. A folder export is always labeled filtered, never a complete project. Traversal may stop at bounded limits and reports the remaining entries as omitted without scanning them. No screenshot attachment was available in this task; styling follows the existing design tokens.

Manual acceptance: Windows clipboard permission/failure; both themes; narrow docked and floating windows; keyboard dismissal/focus; exact raw BOM/CRLF/Unicode copy; unsaved drafts and selection ranges; drive/UNC paths; junctions; sanitized approval after disk edits; large folders and all five budgets. No app launch, browser, provider request or network operation is needed for the source audit.

Automated verification: `npx tsc --noEmit --pretty false` passed; `cargo check --manifest-path src-tauri/Cargo.toml -q` passed; `cargo test --manifest-path src-tauri/Cargo.toml --lib clipboard_ -q` passed (6 tests, 67 filtered out). TypeScript was checked before the final small menu tooltip, empty-editor budget selector and line-warning presentation edits; those final JSX/string edits were source-reviewed. Focused `git diff --check` passed. No production build, full suite, browser, app or provider test was run.
The final extended-path safety adjustment was compiled and verified with `cargo test --manifest-path src-tauri/Cargo.toml --lib clipboard_windows_paths_preserve_unc_and_normal_names -q` (1 passed; 72 filtered out). Ordinary drive/UNC paths are readable; extended-only names retain the prefix to preserve their meaning.
