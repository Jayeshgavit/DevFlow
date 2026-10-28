import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from './AiAssistantPanel';
import type { AiProvider } from './ai-api';
export type Conversation = { id: string; title: string; provider: AiProvider; model: string; draft: string; updated: number; messages: ChatMessage[] };
export type History = { revision: number; location: string; chats: Conversation[] };
export const loadHistory = (projectId: string) => invoke<History>('chat_history_load', { projectId });
export const saveHistory = (projectId: string, lease: number, history: History) => invoke<number>('chat_history_save', { projectId, lease, history });
