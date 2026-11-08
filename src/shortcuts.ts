import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { View } from './types';

type Scope = 'main' | 'editor' | 'window';
type Shortcut = { id: string; name: string; description: string; defaultKey: string; scope: Scope; view?: View };
export const shortcuts: Shortcut[] = [
  { id: 'navigation.quick-editor', name: 'Quick Editor', description: 'Return to the existing editor session.', defaultKey: 'Ctrl+E', scope: 'main', view: 'editor' },
  { id: 'navigation.logs', name: 'Logs', description: 'Show logs for the selected project.', defaultKey: 'Ctrl+L', scope: 'main', view: 'logs' },
  { id: 'navigation.system-monitor', name: 'System Monitor', description: 'Show the existing system monitor.', defaultKey: 'Ctrl+M', scope: 'main', view: 'system' },
  { id: 'navigation.projects', name: 'Projects', description: 'Show project configuration without changing selection.', defaultKey: 'Ctrl+P', scope: 'main', view: 'projects' },
  { id: 'editor.next-tab', name: 'Next editor tab', description: 'Cycle open files without saving or opening files.', defaultKey: 'Ctrl+Tab', scope: 'editor' },
  { id: 'editor.previous-tab', name: 'Previous editor tab', description: 'Cycle open files backwards.', defaultKey: 'Ctrl+Shift+Tab', scope: 'editor' },
  { id: 'editor.project-search', name: 'Search project files', description: 'Find text in saved project files in Quick Editor.', defaultKey: 'Ctrl+Shift+F', scope: 'editor' },
  { id: 'window.minimize', name: 'Minimize active window', description: 'Fallback only; editor and contextual Escape handlers take priority.', defaultKey: 'Escape', scope: 'window' },
  ...(['overview', 'projects', 'logs', 'system', 'maintenance'] as View[]).map((view, i) => ({ id: `legacy.${view}`, name: `${['Overview', 'Projects', 'Logs', 'System Monitor', 'Maintenance'][i]} (alternate)`, description: 'Existing navigation binding; inactive while typing.', defaultKey: `Ctrl+${i + 1}`, scope: 'main' as const, view })),
  { id: 'navigation.settings', name: 'Settings', description: 'Open preferences.', defaultKey: 'Ctrl+,', scope: 'main', view: 'settings' },
  { id: 'search.workspace', name: 'Find project or service', description: 'Open workspace search outside embedded editors.', defaultKey: 'Ctrl+K', scope: 'main' },
  { id: 'search.logs', name: 'Find in Logs', description: 'Focus search in the standalone Logs page.', defaultKey: 'Ctrl+F', scope: 'main' },
];
export type Bindings = Record<string, string | null>;
const storageKey = 'devflow-shortcuts-v1';
export const shortcutDefaults = (): Bindings => Object.fromEntries(shortcuts.map(s => [s.id, s.defaultKey]));
export function keyCombination(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string {
  if (e.metaKey || e.altKey || ['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Process', 'Unidentified'].includes(e.key)) return '';
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey && 'Ctrl', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}
export function bindingError(id: string, key: string | null, bindings: Bindings): string {
  if (key === null) return '';
  // Deliberately bounded recorder vocabulary avoids stealing editing, search,
  // debugger, browser, accessibility or Windows commands from embedded surfaces.
  const ownDefault = shortcuts.find(s => s.id === id)?.defaultKey;
  if (key !== ownDefault && !/^Ctrl\+(Shift\+)?[ELMP1-9,]$/.test(key) && !/^Ctrl\+Shift\+F(?:[6-9]|1[012])$/.test(key)) return 'Reserved or unsupported. Use Ctrl (optionally Shift) with E, L, M, P, 1–9 or comma; or Ctrl+Shift+F6–F12. Editing and system commands are reserved.';
  const conflict = shortcuts.find(s => s.id !== id && bindings[s.id] === key);
  return conflict ? `${key} is assigned to ${conflict.name}. Change or disable that action first.` : '';
}
export function readBindings(): Bindings {
  const result = shortcutDefaults();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
    // Validate the whole candidate before accepting it; malformed storage can
    // never introduce duplicate handlers or erase a default accidentally.
    const candidate = { ...result };
    for (const s of shortcuts) {
      const value = (raw as Bindings)[s.id];
      if (value === null || typeof value === 'string') candidate[s.id] = value;
    }
    if (shortcuts.every(s => !bindingError(s.id, candidate[s.id], candidate))) return candidate;
  } catch { /* Use defaults when storage is unavailable or invalid. */ }
  return result;
}
export function saveBindings(bindings: Bindings) {
  for (const s of shortcuts) { const error = bindingError(s.id, bindings[s.id], bindings); if (error) throw new Error(error); }
  localStorage.setItem(storageKey, JSON.stringify(bindings));
  window.dispatchEvent(new Event(storageKey));
}
export function useBindings() {
  const [bindings, setBindings] = useState(readBindings);
  useEffect(() => {
    const refresh = () => setBindings(readBindings());
    window.addEventListener('storage', refresh); window.addEventListener(storageKey, refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener(storageKey, refresh); };
  }, []);
  return bindings;
}
let activeHandler: ((event: KeyboardEvent) => boolean) | undefined;
/** Called before CodeMirror's default Ctrl+E / Ctrl+L bindings, never for Escape. */
export function editorShortcut(event: KeyboardEvent) { return event.key !== 'Escape' && (activeHandler?.(event) ?? false); }
const visible = (element: Element) => !element.closest('[hidden]') && element.getClientRects().length > 0;
function hasContext() {
  return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], [popover]:popover-open, .cm-panel, .cm-tooltip, .qe-context-menu, [data-shortcut-recorder]')].some(visible);
}
export function useShortcuts(actions: { navigate?: (view: View) => void; search?: () => void; logsSearch?: () => boolean; error: (message: string) => void }) {
  const bindings = useBindings();
  const current = useRef({ actions, bindings }); current.current = { actions, bindings };
  useEffect(() => {
    let minimizing = false;
    const handle = (event: KeyboardEvent): boolean => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey || !document.hasFocus()) return false;
      const target = event.target instanceof Element ? event.target : null;
      const context = hasContext();
      if (context || target?.closest('select, [role="combobox"], [data-shortcut-recorder]')) return false;
      const { bindings: keys, actions: a } = current.current;
      const combination = keyCombination(event);
      const action = shortcuts.find(s => keys[s.id] === combination);
      if (!action) return false;
      if (action.id === 'window.minimize') {
        // CodeMirror, text fields and native widgets retain Escape even if they
        // don't preventDefault. This is intentionally a conservative fallback.
        if (target?.closest('.cm-editor, input, textarea, [contenteditable="true"], details[open]')) return false;
        if (minimizing) return false;
        minimizing = true; event.preventDefault();
        void getCurrentWindow().minimize().catch(() => a.error('Could not minimize this window. Use its title bar.')).finally(() => { minimizing = false; });
        return true;
      }
      if (action.scope === 'editor') {
        const request = new CustomEvent(action.id === 'editor.project-search' ? 'devflow-editor-project-search' : 'devflow-editor-cycle', { cancelable: true, detail: action.id === 'editor.next-tab' ? 1 : -1 });
        if (window.dispatchEvent(request)) return false;
      } else {
        if (!a.navigate) return false;
        const embedded = target?.closest('.cm-editor');
        if (action.id.startsWith('legacy.') && target?.closest('input, textarea, [contenteditable="true"]')) return false;
        if (action.id.startsWith('search.') && embedded) return false;
        if (action.view) a.navigate(action.view);
        else if (action.id === 'search.workspace') a.search?.();
        else if (action.id === 'search.logs' && !a.logsSearch?.()) return false;
        else if (action.id !== 'search.workspace') return false;
      }
      event.preventDefault(); return true;
    };
    activeHandler = handle;
    // Bubble phase lets React, native controls and CodeMirror consume Escape.
    window.addEventListener('keydown', handle);
    return () => { if (activeHandler === handle) activeHandler = undefined; window.removeEventListener('keydown', handle); };
  }, []);
}
