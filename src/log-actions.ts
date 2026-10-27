import { invoke } from '@tauri-apps/api/core';
import type { Project } from './types';

// Native clipboard avoids WebView2 permission/focus differences between windows.
export const writeLogClipboard = (text: string) => invoke<void>('logs_copy', { text });
export const exportLogText = (project: Project, text: string) => invoke<boolean>('logs_export', { projectId: project.id, text });
export type ErrorLocation = { path: string; line: number };
export const verifyErrorLocation = (project: Project, location: ErrorLocation) => invoke<boolean>('logs_verify_location', { projectId: project.id, expectedRoot: project.root, ...location });
export const openErrorLocation = (project: Project, location: ErrorLocation) => invoke<void>('logs_open_location', { projectId: project.id, expectedRoot: project.root, ...location });
