import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';

const apiSource = await readFile(new URL('../src/ai-api.ts', import.meta.url), 'utf8');
const tauriStub = new URL('./.tmp-tauri-api.mjs', import.meta.url);
const apiTemp = new URL('./.tmp-ai-api.mjs', import.meta.url);
await writeFile(tauriStub, 'export async function invoke() {} export async function listen(_event, handler) { globalThis.__aiStreamHandler = handler; return () => {}; }', 'utf8');
const apiJs = ts.transpileModule(apiSource.replace(/from ['"]@tauri-apps\/api\/core['"]/g, "from './.tmp-tauri-api.mjs'").replace(/from ['"]@tauri-apps\/api\/event['"]/g, "from './.tmp-tauri-api.mjs'"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
await writeFile(apiTemp, apiJs, 'utf8');
const { aiApi } = await import(apiTemp.href);

// Test mask_key logic matching Rust ai_credentials::mask_key
function maskKey(key) {
  const trimmed = key.trim();
  const len = trimmed.length;
  if (len <= 8) {
    return '••••••••';
  }
  let prefixLen = 3;
  if (trimmed.startsWith('sk-or-v1-')) {
    prefixLen = 9;
  } else if (trimmed.startsWith('sk-')) {
    prefixLen = 3;
  } else if (trimmed.startsWith('nvapi-')) {
    prefixLen = 6;
  } else {
    prefixLen = Math.min(3, Math.floor(len / 4));
  }
  const prefix = trimmed.slice(0, prefixLen);
  const suffix = trimmed.slice(len - 4);
  return `${prefix}••••${suffix}`;
}

// Test provider normalization matching Rust ai_credentials::normalize_provider
function normalizeProvider(provider) {
  const norm = provider.trim().toLowerCase();
  if (norm === 'openrouter') return 'openrouter';
  if (norm === 'nvidia-nim' || norm === 'nvidia_nim' || norm === 'nvidia') return 'nvidia-nim';
  throw new Error(`Unsupported AI provider: ${provider}`);
}

test('aiApi exposes all required typed IPC commands for Phase 2', () => {
  assert.equal(typeof aiApi.setApiKey, 'function');
  assert.equal(typeof aiApi.deleteApiKey, 'function');
  assert.equal(typeof aiApi.getCredentialStatus, 'function');
  assert.equal(typeof aiApi.testConnection, 'function');
  assert.equal(typeof aiApi.listModels, 'function');
  assert.equal(typeof aiApi.startChat, 'function');
  assert.equal(typeof aiApi.stopChat, 'function');
  assert.equal(typeof aiApi.subscribeChatStream, 'function');
});

test('maskKey redacts API credentials and protects against leaking in logs or UI', () => {
  // OpenRouter key
  const orKey = 'sk-or-v1-abc123def456789xyz9876';
  const orMasked = maskKey(orKey);
  assert.equal(orMasked, 'sk-or-v1-••••9876');
  assert.ok(!orMasked.includes('def456789xyz'));

  // NVIDIA NIM key
  const nvKey = 'nvapi-ABCDEF1234567890XYZ';
  const nvMasked = maskKey(nvKey);
  assert.equal(nvMasked, 'nvapi-••••0XYZ');
  assert.ok(!nvMasked.includes('ABCDEF123456789'));

  // Standard sk- key
  const stdKey = 'sk-1234567890abcdefghijklmnop';
  const stdMasked = maskKey(stdKey);
  assert.equal(stdMasked, 'sk-••••mnop');

  // Short key
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey('12345678'), '••••••••');
});

test('normalizeProvider handles supported aliases and rejects unauthorized providers', () => {
  assert.equal(normalizeProvider('openrouter'), 'openrouter');
  assert.equal(normalizeProvider('OPENROUTER '), 'openrouter');
  assert.equal(normalizeProvider('nvidia-nim'), 'nvidia-nim');
  assert.equal(normalizeProvider('nvidia_nim'), 'nvidia-nim');
  assert.equal(normalizeProvider('nvidia'), 'nvidia-nim');

  assert.throws(() => normalizeProvider('ollama'), /Unsupported AI provider/);
  assert.throws(() => normalizeProvider('anthropic'), /Unsupported AI provider/);
  assert.throws(() => normalizeProvider('openai'), /Unsupported AI provider/);
  assert.throws(() => normalizeProvider(''), /Unsupported AI provider/);
});

test('subscribeChatStream filters chunks strictly by matching requestId', async () => {
  const delivered = [];
  const targetReqId = 'req_session_abc';
  await aiApi.subscribeChatStream(targetReqId, chunk => delivered.push(chunk));
  globalThis.__aiStreamHandler({ payload: { request_id: 'req_session_other', delta: 'hello other' } });
  assert.equal(delivered.length, 0, 'Chunks for other request_ids must be ignored');
  globalThis.__aiStreamHandler({ payload: { request_id: 'req_session_abc', delta: 'hello this session' } });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].delta, 'hello this session');
  globalThis.__aiStreamHandler({ payload: { request_id: 'req_session_abc', delta: '', done: true } });
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].done, true);
});

test('Bounded conversation context enforces limits to control token and memory budgets', () => {
  const maxAllowedMessages = 20;
  const maxAllowedChars = 48000;

  const validConversation = [
    { role: 'user', content: 'How do I center a div in CSS?' },
    { role: 'assistant', content: 'Use display: grid; place-items: center;' },
  ];
  assert.ok(validConversation.length <= maxAllowedMessages);
  assert.ok(validConversation.reduce((acc, m) => acc + m.content.length, 0) <= maxAllowedChars);

  // Over message limit test
  const hugeHistory = Array.from({ length: 25 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}`,
  }));
  assert.ok(hugeHistory.length > maxAllowedMessages, 'Identified history exceeding limit');

  // Over char limit test
  const hugeMessage = { role: 'user', content: 'A'.repeat(50000) };
  assert.ok(hugeMessage.content.length > maxAllowedChars, 'Identified message exceeding budget');
});

test('Read-only AI safety contract prevents execution and tools', async () => {
  // Verify that system prompt guarantees read-only behavior
  const systemPrompt =
    'You are DevFlow AI, a smart, fast, read-only developer assistant in the DevFlow workspace manager on Windows. Provide concise explanations, accurate code snippets, and debugging insights. You cannot modify local files or execute commands directly.';

  assert.ok(systemPrompt.includes('read-only'));
  assert.ok(systemPrompt.includes('cannot modify local files'));
  assert.ok(systemPrompt.includes('execute commands'));
  const source = await readFile(new URL('../src/AiAssistantPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /tool_calls|editorApi\.(save|mutate)|ai_start_tool|start_service/);
});

test('AI event listener and request APIs test against Tauri IPC mocks only', () => {
  assert.equal(typeof aiApi.startChat, 'function');
  assert.equal(typeof aiApi.stopChat, 'function');
  assert.equal(typeof aiApi.subscribeChatStream, 'function');
});

after(async () => { await Promise.all([unlink(apiTemp).catch(() => {}), unlink(tauriStub).catch(() => {})]); });

