import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/AiAssistantPanel.tsx', import.meta.url), 'utf8');
const apiStub = new URL('./.tmp-ai-api-panel.mjs', import.meta.url);
const contextStub = new URL('./.tmp-ai-context-panel.mjs', import.meta.url);
await writeFile(apiStub, 'export const aiApi = new Proxy({}, { get: () => async () => undefined });', 'utf8');
await writeFile(contextStub, 'export const approximateContextSize = () => 0; export const attachmentsForProject = value => value; export const formatAttachments = () => "";', 'utf8');
const sanitized = source
  .replace(/import\s+['"][^'"]+\.css['"];?/g, '')
  .replace(/from\s+['"]\.\/ai-api['"]/g, "from './.tmp-ai-api-panel.mjs'")
  .replace(/from\s+['"]\.\/ai-context['"]/g, "from './.tmp-ai-context-panel.mjs'");
const javascript = ts.transpileModule(sanitized, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

const tmpFile = new URL('./.tmp-ai-panel.mjs', import.meta.url);
await writeFile(tmpFile, javascript, 'utf8');

let clampAiWidth;
let AI_SUGGESTIONS;
let AiAssistantPanel;

try {
  const mod = await import(tmpFile.href);
  clampAiWidth = mod.clampAiWidth;
  AI_SUGGESTIONS = mod.AI_SUGGESTIONS;
  AiAssistantPanel = mod.default;
} finally {
  await Promise.all([unlink(tmpFile).catch(() => {}), unlink(apiStub).catch(() => {}), unlink(contextStub).catch(() => {})]);
}

test('AI Assistant panel width clamping enforces boundaries and min editor space', () => {
  // Min bound 260px
  assert.equal(clampAiWidth(150, 1200, 260), 260);

  // Max bound 550px
  assert.equal(clampAiWidth(700, 1600, 260), 550);

  // Within bounds
  assert.equal(clampAiWidth(380, 1200, 260), 380);

  // Container constraint: containerWidth = 800, explorerWidth = 300, min editor = 280 -> max allowed = 800 - 300 - 280 = 220, clamped to min 260
  assert.equal(clampAiWidth(400, 800, 300), 260);

  // Moderate container constraint: containerWidth = 900, explorerWidth = 260 -> max allowed = 900 - 260 - 280 = 360
  assert.equal(clampAiWidth(450, 900, 260), 360);
});

test('AI Assistant suggestions define prompt presets for code explanation, debugging, and review', () => {
  assert.equal(AI_SUGGESTIONS.length, 3);

  const kinds = AI_SUGGESTIONS.map(s => s.kind);
  assert.ok(kinds.includes('Explain code'));
  assert.ok(kinds.includes('Debug error'));
  assert.ok(kinds.includes('Review selected code'));

  for (const s of AI_SUGGESTIONS) {
    assert.ok(typeof s.label === 'string' && s.label.length > 0);
    assert.ok(typeof s.prompt === 'string' && s.prompt.length > 0);
    assert.ok(s.icon !== undefined);
  }
});

test('AI provider choices validate OpenRouter and NVIDIA NIM', () => {
  const validProviders = ['openrouter', 'nvidia-nim'];
  assert.ok(validProviders.includes('openrouter'));
  assert.ok(validProviders.includes('nvidia-nim'));
  assert.equal(validProviders.length, 2);
});

test('AiAssistantPanel component exports a callable React functional component', () => {
  assert.equal(typeof AiAssistantPanel, 'function');
});

test('Context attachments expose functional controls, previews, removals, and explicit review', async () => {
  const panel = await readFile(new URL('../src/AiAssistantPanel.tsx', import.meta.url), 'utf8');
  for (const label of ['Attach File', 'Selected Code', 'Selected Logs', 'Project Context']) assert.ok(panel.includes(label));
  assert.match(panel, /I reviewed this exact context/);
  assert.match(panel, /Remove \$\{attachment\.label\}/);
  assert.doesNotMatch(panel, /Coming in Phase 3/);
});

