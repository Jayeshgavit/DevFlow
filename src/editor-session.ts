import type { Project } from './types';
import type { FileDocument } from './editor-api';

export type EditorTab = { path: string; document: FileDocument; baseline: string; text: string; editing: boolean; surfaceOpened: boolean; backup: string };
export type EditorSession = { workspace?: Project; tabs: EditorTab[]; active: string; width: number; collapsed: boolean; layout?: { logsOpen: boolean; logsHeight: number; expanded: string[] }; ai?: { open: boolean; width: number; provider: import('./ai-api').AiProvider; model: string; draft: string; messages: import('./AiAssistantPanel').ChatMessage[]; attachments: import('./ai-context').AiAttachment[]; reviewed: string } };
export const tabKey = (path: string) => path.toLowerCase();
export const tabDirty = (tab: EditorTab) => tab.text !== tab.baseline;
export const sessionDirty = (tabs: EditorTab[]) => tabs.some(tabDirty);
export function closeTab(tabs: EditorTab[], active: string, path: string) {
  const index = tabs.findIndex(tab => tabKey(tab.path) === tabKey(path));
  const remaining = tabs.filter(tab => tabKey(tab.path) !== tabKey(path));
  return { tabs: remaining, active: tabKey(active) === tabKey(path) ? remaining[Math.min(index, remaining.length - 1)]?.path || '' : active };
}

export function renamedPath(path: string, previous: string, next: string) {
  return tabKey(path) === tabKey(previous) ? next : tabKey(path).startsWith(`${tabKey(previous)}/`) ? next + path.slice(previous.length) : path;
}
export function renameTabs(tabs: EditorTab[], previous: string, next: string) {
  return tabs.map(tab => ({ ...tab, path: renamedPath(tab.path, previous, next) }));
}
