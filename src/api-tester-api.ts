import { invoke } from '@tauri-apps/api/core';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type Method = typeof METHODS[number];
export type Pair = { id: string; enabled: boolean; key: string; value: string; secret: boolean };
export type ApiRequest = {
  method: Method; url: string; params: Pair[]; headers: Pair[]; bodyMode: 'none' | 'json' | 'text' | 'form';
  body: string; form: Pair[]; bodySecret: boolean; auth: 'none' | 'bearer' | 'basic' | 'headers';
  token: string; username: string; password: string; timeoutSeconds: number;
};
export type ApiOutcome = {
  kind: string; message: string; status: number | null; statusLabel: string; durationMs: number; size: number;
  headers: [string, string][]; body: string; truncated: boolean;
};
export type SavedRequest = { id: string; name: string; collection: string; request: ApiRequest };
export type ApiHistory = { id: string; timestamp: number; method: Method; url: string; durationMs: number; result: string; request: ApiRequest };
export type ApiStore = { version: number; projectId: string; revision: number; requests: SavedRequest[]; collections: string[]; history: ApiHistory[]; lastSelected: string | null };
export const apiTester = {
  load: (projectId: string) => invoke<ApiStore>('api_tester_load', { projectId }),
  save: (projectId: string, store: ApiStore) => invoke<ApiStore>('api_tester_save', { projectId, store }),
  prepare: (projectId: string, requestId: string) => invoke<void>('api_tester_prepare', { projectId, requestId }),
  send: (projectId: string, requestId: string, request: ApiRequest) => invoke<ApiOutcome>('api_tester_send', { projectId, requestId, request }),
  cancel: (requestId: string) => invoke<void>('api_tester_cancel', { requestId }),
};
