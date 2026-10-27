import { invoke } from '@tauri-apps/api/core';
import type { Project } from './types';

export type FileEntry = { name: string; path: string; directory: boolean; blocked: boolean };
export type FileDocument = { content: string; lineEnding: 'LF' | 'CRLF' | 'mixed'; readOnly: boolean };
export type CopyExport = { text: string; warnings: string[]; files: number };
export type FileVersion = { id: string; timestamp: number; path: string };
export type FileHistory = { versions: FileVersion[]; limitation: string };
export type FileComparison = { snapshot: string; current: FileDocument };
export const editorApi = {
  history: (project: Project, path: string) => invoke<FileHistory>('editor_history', { projectId: project.id, expectedRoot: project.root, path }),
  snapshot: (project: Project, path: string, id: string) => invoke<FileComparison>('editor_snapshot', { projectId: project.id, expectedRoot: project.root, path, id }),
  restore: (project: Project, path: string, id: string, expected: string, lease: number) => invoke<FileDocument>('editor_restore', { projectId: project.id, expectedRoot: project.root, path, id, expected, lease }),
  lease: () => invoke<number>('editor_writer_lease'),
  export: (project: Project, path: string, mode: 'file' | 'folder' | 'tree', draft?: string) => invoke<CopyExport>('editor_export', { projectId: project.id, expectedRoot: project.root, path, mode, draft }),
  mutate: (project: Project, path: string, action: 'file' | 'folder' | 'rename', name: string, lease: number) => invoke<string>('editor_mutate', { projectId: project.id, expectedRoot: project.root, path, action, name, lease }),
  reveal: (project: Project, path: string, directory: boolean) => invoke<void>('editor_reveal', { projectId: project.id, expectedRoot: project.root, path, directory }),
  list: (project: Project, path: string) => invoke<FileEntry[]>('editor_list', { projectId: project.id, expectedRoot: project.root, path }),
  read: (project: Project, path: string) => invoke<FileDocument>('editor_read', { projectId: project.id, expectedRoot: project.root, path }),
  save: (project: Project, path: string, expected: string, content: string, lease: number) => invoke<string>('editor_save', { projectId: project.id, expectedRoot: project.root, path, expected, content, lease }),
};

export const extension = (path: string) => path.split('.').pop()?.toLowerCase() || '';
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
export const normalizeText = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
export function diskText(text: string, document: FileDocument) {
  return (document.content.startsWith('\uFEFF') ? '\uFEFF' : '') + (document.lineEnding === 'CRLF' ? text.replace(/\n/g, '\r\n') : text);
}
export type CodeSlice = { text: string; from: number; to: number };
export function aiContext(path: string, slice: CodeSlice) {
  const language = ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', py: 'python', md: 'markdown', markdown: 'markdown', json: 'json', html: 'html', css: 'css' } as Record<string, string>)[extension(path)] || 'text';
  // A longer fence safely contains source that itself includes Markdown fences.
  let fenceLength = 3;
  for (const match of slice.text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `File: ${path}\nLines: ${slice.from}${slice.to === slice.from ? '' : `-${slice.to}`}\n\n${fence}${language}\n${slice.text}\n${fence}`;
}
