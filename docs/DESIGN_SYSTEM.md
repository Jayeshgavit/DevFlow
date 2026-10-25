# DevFlow design system

DevFlow is a local development workspace manager. The interface gives project commands, service state, and logs priority. It does not present simulated analytics or editor controls.

## Themes and color roles

Theme values live in `src/style.css` as CSS custom properties. Components use semantic variables (`--surface`, `--text`, `--border-soft`, `--success`, `--danger`, `--focus`) so both themes stay aligned. The saved setting is `light`, `dark`, or `system`; `system` follows the operating system preference.

| Role | Light | Dark |
| --- | --- | --- |
| Background | `#F6F5F1` | `#101112` |
| Primary surface | `#FFFFFF` | `#1D1F23` |
| Elevated surface | `#FFFFFF` | `#282B30` |
| Primary text | `#14213D` | `#F5F6F8` |
| Secondary text | `#516078` | `#A2A7B0` |
| Border anchor | `#14213D` | `#343840` |
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

- **Sidebar:** four real views, project selection, import, and a theme shortcut. Selected view has a persistent label and focus state.
- **Button and Card:** shared primitives with primary, secondary, quiet, and danger button styles. Disabled means unavailable; it does not imply success.
- **Status:** derived from Rust's current running registry, with a local error state after a failed start. It does not claim port readiness.
- **Service row:** editable name, directory, executable, and one argument per line; start, forced stop, restart, and removal actions. Forced termination has a confirmation dialog.
- **Log viewer:** combined and service tabs, search, copy, export, clear visible output, and auto-scroll. Stderr and system lines have distinct treatments. Logs remain in the existing bounded frontend session buffer.
- **Empty, loading, and error states:** explain the next useful action without invented activity.
- **Settings:** saved theme and compact density preferences in local storage. Project definitions remain in the existing Tauri app-config JSON.

## Accessibility and responsive behavior

Use native buttons and labelled inputs. Keyboard focus uses `--focus`; dialogs focus Cancel and close with Escape. Controls remain usable at the configured 850 px minimum Tauri window width, while narrower CSS breakpoints collapse the sidebar to icons and stack service fields. Motion is short and disabled under `prefers-reduced-motion`.

## Visual principles

Keep project work and logs immediately visible. Use large headings sparingly, dense but readable service panels, and accent color for meaning. Do not add fake resource charts, decorative dashboards, broad neon glows, or controls without a real action. Preserve typed Tauri IPC names and event contracts when changing presentation.
