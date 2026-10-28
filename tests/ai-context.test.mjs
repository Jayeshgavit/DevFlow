import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import ts from 'typescript';

const sources = await Promise.all([
  readFile(new URL('../src/log-utils.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/ai-context.ts', import.meta.url), 'utf8'),
]);
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const logTemp = new URL('./.tmp-log-utils-verify.mjs', import.meta.url);
const contextTemp = new URL('./.tmp-ai-context-verify.mjs', import.meta.url);
await writeFile(logTemp, compile(sources[0]), 'utf8');
await writeFile(contextTemp, compile(sources[1].replace(/from ['"]\.\/log-utils['"]/g, "from './.tmp-log-utils-verify.mjs'")), 'utf8');
let context;
try { context = await import(contextTemp.href); }
finally { await Promise.all([unlink(logTemp).catch(() => {}), unlink(contextTemp).catch(() => {})]); }

test('saved and unsaved file context is labeled and remains unsaved', () => {
  const saved = context.fileAttachment('p1', 'Demo', 'src/app.ts', 'typescript', 'export const x = 1;', false);
  const draft = context.fileAttachment('p1', 'Demo', 'src/app.ts', 'typescript', 'export const x = 2;', true);
  assert.match(saved.content, /Saved file snapshot/);
  assert.match(draft.content, /Unsaved draft \(not saved to disk\)/);
  assert.match(draft.label, /Unsaved draft/);
  assert.match(context.formatAttachments([draft]), /untrusted reference data/);
});

test('selected code includes the exact selected line range and rejects empty selection', () => {
  const selected = context.selectionAttachment('p1', 'Demo', 'src/app.ts', 'typescript', 'const answer = 42;', 8, 9, false);
  assert.equal(selected.label, 'src/app.ts:8-9 · snapshot');
  assert.match(selected.content, /Lines: 8-9/);
  assert.match(selected.content, /const answer = 42/);
  assert.throws(() => context.selectionAttachment('p1', 'Demo', 'src/app.ts', 'typescript', '', 1, 1, false), /Select code/);
});

test('selected logs stay within one project and include service, time and severity', () => {
  const entries = [
    { projectId: 'p1', serviceId: 'api', stream: 'stderr', message: 'failed request', receivedAt: 0 },
    { projectId: 'p2', serviceId: 'other', stream: 'stderr', message: 'other project secret', receivedAt: 0 },
  ];
  const attachment = context.logAttachment('p1', 'Demo', [{ id: 'api', name: 'API' }], entries, 'Selected logs');
  assert.match(attachment.content, /\[Demo\] \[API\] \[1970-01-01T00:00:00.000Z\] \[error\]/);
  assert.doesNotMatch(attachment.content, /other project secret/);
});

test('project switching removes incompatible attachment snapshots', () => {
  const first = context.fileAttachment('p1', 'One', 'a.ts', 'typescript', 'one', false);
  const second = context.fileAttachment('p2', 'Two', 'b.ts', 'typescript', 'two', false);
  assert.deepEqual(context.attachmentsForProject([{ ...first, id: '1' }, { ...second, id: '2' }], 'p2').map(item => item.id), ['2']);
});

test('project context contains bounded tree names and metadata without adding source contents', () => {
  const attachment = context.projectContextAttachment('p1', 'Demo', [{ name: 'Web', framework: 'Vite', role: 'frontend' }], 'src/\n└── app.ts');
  assert.match(attachment.content, /Vite.*frontend/);
  assert.match(attachment.content, /src\/[\s\S]*app.ts/);
  assert.doesNotMatch(attachment.content, /export const/);
  assert.match(attachment.label, /snapshot/);
});

test('secret values are masked and unclassifiable secrets and absolute paths are blocked', () => {
  assert.match(context.safeAiContext('api_key=sk-or-v1-abcdefghijklmnop'), /\[redacted\]/);
  assert.throws(() => context.safeAiContext('-----BEGIN PRIVATE KEY-----'), /blocked/);
  assert.doesNotMatch(context.safeAiContext('Location: C:\\Users\\Alice\\app.ts'), /C:\\Users/);
});

test('safe attachment revalidation is idempotent across lines and does not confuse environment access with files', () => {
  const input = 'const api_key = process.env.OPENAI_API_KEY;\nconst nextStatement = "ordinary code";\nconst max_tokens = 2048;';
  const safe = context.safeAiContext(input);
  assert.equal(context.safeAiContext(safe), safe);
  assert.doesNotThrow(() => context.formatAttachments([{ id: 'a', projectId: 'p', kind: 'file', label: 'src/example.ts', content: safe }]));
  assert.equal(context.safeAiContext('const api = process.env.API_URL;'), 'const api = process.env.API_URL;');
  assert.doesNotMatch(context.safeAiContext('File: C:/Users/Alice/project.ts'), /C:\/Users/);
  assert.doesNotMatch(context.safeAiContext('File: /home/alice/project.ts'), /\/home\//);
  assert.throws(() => context.fileAttachment('p', 'Demo', '../other/file.ts', 'ts', 'code', false), /relative/);
  assert.throws(() => context.safeAiContext('safe\n-----BEGIN PRIVATE KEY-----'), /private key material on line 2/);
});

test('file snapshots deduplicate across picker/editor labels while selections remain separate', () => {
  const first = { ...context.fileAttachment('p', 'Demo', 'src/widget.ts', 'ts', 'source', true), id: 'one' };
  assert.equal(context.attachmentDuplicate([first], { projectId: 'p', kind: 'file', sourcePath: 'SRC/widget.ts', label: 'different', content: 'new' }), true);
  assert.equal(context.attachmentDuplicate([first], { projectId: 'other', kind: 'file', sourcePath: 'src/widget.ts', label: 'different', content: 'new' }), false);
  assert.equal(context.attachmentDuplicate([first], { projectId: 'p', kind: 'selection', label: first.label, content: first.content }), false);
});

test('attachment total limit is enforced and context previews are sent only when requested', () => {
  assert.throws(() => context.formatAttachments([{ id: 'x', projectId: 'p1', kind: 'file', label: 'large.ts', content: 'x'.repeat(context.AI_ATTACHMENT_LIMIT + 1) }]), /12,000 bytes/);
  assert.equal(context.formatAttachments([]), '');
  const value = context.fileAttachment('p1', 'Demo', 'x.ts', 'typescript', 'source', false);
  assert.match(context.formatAttachments([{ ...value, id: 'x' }]), /source/);
});

test('diagnostic path proposal preserves traceback filename, line, and structure', () => {
  const original = 'File "C:\\Projects\\myapp\\backend\\app\\services\\user_service.py", line 42, in create_user\nValueError: bad value';
  const proposed = context.sanitizeDiagnosticPaths(original);
  assert.match(proposed, /File "\[local path\]\/user_service\.py", line 42, in create_user/);
  assert.match(proposed, /ValueError: bad value/);
  assert.doesNotMatch(proposed, /C:\\Projects/);
  assert.equal(context.sanitizeDiagnosticPaths(proposed), proposed);
});
