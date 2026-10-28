import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2020 } }).outputText;
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(compile(source)).toString('base64')}`;
const smart = moduleUrl(await readFile(new URL('../src/smart-replace.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/paste-new-file.ts', import.meta.url), 'utf8');
const { parseNewFiles, newFilePath, destination } = await import(moduleUrl(source.replace("from './smart-replace'", `from '${smart}'`)));

test('preserves plain source, CRLF, indentation and meaningful whitespace', () => {
  const code = '\tconst x = 1;  \r\n\r\n';
  assert.deepEqual(parseNewFiles(code), [{ code, language: '', path: undefined }]);
});
test('separates labeled files and discards fenced explanations', () => {
  const blocks = parseNewFiles('Explanation\r\nFile: src\\Login.tsx\r\n```tsx\r\n  export const x = 1;\r\n```\r\nMore explanation\r\nPath: src/Login.css\r\n```css\r\na { color: red; }\r\n```\r\nDone');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, 'src/Login.tsx');
  assert.equal(blocks[0].code, '  export const x = 1;\r\n');
  assert.equal(blocks[1].path, 'src/Login.css');
});
test('recognizes headings, inline filenames, extensionless labels and Copy for AI metadata', () => {
  assert.equal(parseNewFiles('### `src/a.ts`\n```ts\na\n```')[0].path, 'src/a.ts');
  assert.equal(parseNewFiles('```ts path=src\\a.ts\na\n```')[0].path, 'src/a.ts');
  assert.equal(parseNewFiles('File: Dockerfile\nFROM node\n')[0].path, 'Dockerfile');
  const blocks = parseNewFiles('PROJECT: Demo\n--- FILE ---\nFILE: src/a.ts\nNAME: a.ts\nLANGUAGE: typescript\nCONTENT:\n```typescript\na\n```\n--- END FILE ---');
  assert.equal(blocks[0].path, 'src/a.ts');
  assert.equal(blocks[0].code, 'a\n');
});
test('unnamed blocks remain distinct, requiring user naming and selection', () => {
  const blocks = parseNewFiles('```ts\na\n```\n```ts\nb\n```');
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(block => !block.path));
  assert.throws(() => destination(blocks[0], { name: '', folder: '', resolution: '' }));
});
test('rejects invalid content, unsafe paths and ambiguous file labels', () => {
  for (const value of ['', '\0', 'x'.repeat(262145), '```ts\n```', '```ts\nx', 'File: ../x.ts\n```ts\nx\n```', 'File: a.ts\nx\nFile: b.ts\ny']) assert.throws(() => parseNewFiles(value));
  for (const value of ['../x.ts', 'C:\\x.ts', '\\\\server\\x.ts', '/x.ts', 'x.ts:stream', 'src/CON.ts', 'src/CON .txt', 'src/a.', 'src//x.ts', `${'x'.repeat(256)}.ts`]) assert.throws(() => newFilePath(value));
});
test('requires explicit folder/path conflict resolution and previews each choice', () => {
  const block = { path: 'src/a.ts', code: 'x', language: 'ts' };
  const choice = { name: 'src/a.ts', folder: 'other', resolution: '' };
  assert.throws(() => destination(block, choice), /Choose/);
  assert.equal(destination(block, { ...choice, resolution: 'clipboard' }), 'src/a.ts');
  assert.equal(destination(block, { ...choice, resolution: 'folder' }), 'other/a.ts');
  assert.equal(destination(block, { ...choice, folder: 'src' }), 'src/a.ts');
});
