import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type AiProvider = 'openrouter' | 'nvidia-nim';


export interface CredentialStatus {
  provider: string;
  has_key: boolean;
  masked?: string | null;
}

export interface TestConnectionResult {
  provider: string;
  success: boolean;
  message: string;
}

export interface AiModelInfo {
  id: string;
  name: string;
  context_length?: number | null;
  description?: string | null;
  supports_tools?: boolean | null;
  is_free?: boolean | null;
  is_default: boolean;
}

export interface ModelCheckResult {
  model: string;
  status: 'working' | 'unavailable' | 'unknown';
  message: string;
  retry_after_seconds?: number | null;
  stop_batch?: boolean;
}

export interface ChatMessagePayload {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StartChatRequest {
  request_id: string;
  provider: string;
  model: string;
  messages: ChatMessagePayload[];
  temperature?: number;
  max_tokens?: number;
  research_token?: string;
  mode: 'chat' | 'research' | 'web';
}

export interface ChatStreamChunk {
  request_id: string;
  delta: string;
  done: boolean;
  cancelled: boolean;
  error?: string | null;
  activity?: string | null;
  references?: { path: string; line?: number | null }[] | null;
}

export const aiApi = {
  checkModel: (provider: AiProvider, model: string, research: boolean): Promise<ModelCheckResult> =>
    invoke<ModelCheckResult>('ai_check_model', { provider, model, research }),
  researchContext: (projectId: string, expectedRoot: string, lease: number): Promise<string> =>
    invoke<string>('ai_research_context', { projectId, expectedRoot, lease }),
  clearResearchContext: (token: string): Promise<void> =>
    invoke<void>('ai_clear_research_context', { token }),

  setApiKey: (provider: AiProvider, key: string): Promise<void> =>
    invoke<void>('ai_set_api_key', { provider, key }),

  deleteApiKey: (provider: AiProvider): Promise<void> =>
    invoke<void>('ai_delete_api_key', { provider }),

  getCredentialStatus: (provider: AiProvider): Promise<CredentialStatus> =>
    invoke<CredentialStatus>('ai_get_credential_status', { provider }),

  testConnection: (provider: AiProvider): Promise<TestConnectionResult> =>
    invoke<TestConnectionResult>('ai_test_connection', { provider }),

  listModels: (provider: AiProvider): Promise<AiModelInfo[]> =>
    invoke<AiModelInfo[]>('ai_list_models', { provider }),

  startChat: (request: StartChatRequest): Promise<void> =>
    invoke<void>('ai_start_chat', { request }),

  stopChat: (requestId: string): Promise<boolean> =>
    invoke<boolean>('ai_stop_chat', { requestId }),

  subscribeChatStream: async (
    requestId: string,
    onChunk: (chunk: ChatStreamChunk) => void
  ): Promise<UnlistenFn> => {
    return listen<ChatStreamChunk>('ai-chat-delta', (event) => {
      if (event.payload && event.payload.request_id === requestId) {
        onChunk(event.payload);
      }
    });
  },
};

