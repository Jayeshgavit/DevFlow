import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/editor-session.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { closeTab, tabDirty, sessionDirty, tabKey, renamedPath, renameTabs } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const smartSource = await readFile(new URL('../src/smart-replace.ts', import.meta.url), 'utf8');
const smartJs = ts.transpileModule(smartSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  .replaceAll("'@codemirror/lang-javascript'", JSON.stringify(import.meta.resolve('@codemirror/lang-javascript')))
  .replaceAll("'@codemirror/lang-python'", JSON.stringify(import.meta.resolve('@codemirror/lang-python')));
const { parseClipboard, relativeClipboardPath, matchSections, replacementPreview } = await import(`data:text/javascript;base64,${Buffer.from(smartJs).toString('base64')}`);

test('Smart Replace preserves separate fenced blocks, exact whitespace and path labels', () => {
  const blocks = parseClipboard('File: src/Widget.tsx\r\n```tsx\r\n  const Widget = () => <p />;\r\n```\r\n\r\nother.py\n~~~python\ndef other():\n    pass\n~~~');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, 'src/Widget.tsx');
  assert.equal(blocks[0].code, '  const Widget = () => <p />;\r\n');
  assert.equal(blocks[1].language, 'python');
  assert.equal(parseClipboard('const Widget = () => 1;')[0].code, 'const Widget = () => 1;');
  assert.equal(parseClipboard('```ts filename=src/a.ts\nconst a = 1;\n```')[0].path, 'src/a.ts');
});
test('Smart Replace rejects unsafe paths and malformed clipboard', () => {
  for (const path of ['../x.ts', '/x.ts', 'C:/x.ts', 'a.ts:stream', 'a\\b.ts', 'a/./b.ts', 'a//b.ts']) assert.throws(() => relativeClipboardPath(path));
  for (const value of ['', '\0binary', '```ts\nmissing close', 'x'.repeat(262145), 'File: ../x.ts\n```ts\na\n```']) assert.throws(() => parseClipboard(value));
});
test('Smart Replace uses exact TSX parser ranges and refuses ambiguous/common/multiple declarations', async () => {
  const original = 'import React from "react";\nexport const Widget = () => <p>{"}"}</p>;\nconst untouched = 1;\n';
  const code = 'export const Widget = () => <strong>new</strong>;';
  const ranges = await matchSections(original, code, 'Widget.tsx');
  assert.equal(ranges.length, 1);
  const preview = replacementPreview(original, ranges[0], code);
  assert.equal(preview.result, `import React from "react";\n${code}\nconst untouched = 1;\n`);
  assert.equal(preview.removed, 1); assert.equal(preview.added, 1);
  assert.equal((await matchSections('function App() {}', 'function App() { return 1; }', 'App.tsx')).length, 0);
  assert.equal((await matchSections('const Widget = 1, Other = 2;', 'const Widget = 3;', 'x.ts')).length, 0);
  assert.equal((await matchSections('export const Widget = 1, Other = 2;', 'export const Widget = 3;', 'x.ts')).length, 0);
  assert.equal((await matchSections('function Widget() {}\nfunction Widget() {}', 'function Widget() { return 1; }', 'x.ts')).length, 2);
  assert.equal((await matchSections(original, code + '\nconst extra = 2;', 'x.tsx')).length, 0);
});
test('Smart Replace Python ranges and selection splice preserve surrounding draft content', async () => {
  const original = 'before = 1\n\ndef calculate(value):\n    return value + 1\n\nafter = 2\n';
  const code = 'def calculate(value):\n    return value * 2';
  const ranges = await matchSections(original, code, 'work.py');
  assert.equal(ranges.length, 1);
  const changed = replacementPreview(original, ranges[0], code).result;
  assert.ok(changed.startsWith('before = 1\n\n')); assert.ok(changed.endsWith('\n\nafter = 2\n'));
  assert.equal(replacementPreview('one DRAFT three', { from: 4, to: 9 }, 'updated').result, 'one updated three');
  assert.throws(() => replacementPreview('abc', { from: 0, to: 4 }, ''));
  const empty = replacementPreview('', { from: 0, to: 0 }, 'new');
  assert.equal(empty.removed, 0); assert.equal(empty.added, 1);
  assert.equal(replacementPreview('new', { from: 3, to: 3 }, '\n').newlineChanged, true);
});
const tab = (path, content = 'saved', text = content) => ({ path, document: { content, lineEnding: 'LF', readOnly: false }, baseline: content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), text, editing: true, surfaceOpened: true, backup: '' });

test('dirty detection respects BOM/CRLF and sees inactive drafts', () => {
  const clean = tab('a.ts', '\uFEFFone\r\ntwo\r\n', 'one\ntwo\n');
  assert.equal(tabDirty(clean), false);
  assert.equal(sessionDirty([clean, tab('b.ts', 'disk', 'draft')]), true);
  assert.equal(sessionDirty([clean]), false);
});
test('closing an inactive tab preserves the active draft object', () => {
  const draft = tab('a.ts', 'disk', 'unsaved');
  const result = closeTab([draft, tab('b.ts')], 'a.ts', 'b.ts');
  assert.equal(result.active, 'a.ts');
  assert.equal(result.tabs[0], draft);
  assert.equal(result.tabs[0].text, 'unsaved');
});
test('closing the active tab selects a neighbor, then the last close empties the session', () => {
  const tabs = [tab('a.ts'), tab('b.ts'), tab('c.ts')];
  assert.equal(closeTab(tabs, 'b.ts', 'b.ts').active, 'c.ts');
  assert.equal(closeTab(tabs, 'c.ts', 'c.ts').active, 'b.ts');
  assert.deepEqual(closeTab([tabs[0]], 'a.ts', 'a.ts'), { tabs: [], active: '' });
});
test('Windows path casing maps to one tab identity', () => {
  assert.equal(tabKey('src/Header.tsx'), tabKey('SRC/header.TSX'));
  assert.deepEqual(closeTab([tab('src/Header.tsx')], 'src/Header.tsx', 'SRC/HEADER.tsx'), { tabs: [], active: '' });
});
test('handoff serialization preserves project, all drafts and edit modes', () => {
  const session = { workspace: { id: 'p', root: 'D:/work' }, tabs: [tab('a.ts', 'old', 'draft'), { ...tab('b.md'), editing: false }], active: 'b.md', width: 240, collapsed: true };
  const restored = JSON.parse(JSON.stringify(session));
  assert.deepEqual(restored, session);
  assert.equal(sessionDirty(restored.tabs), true);
});

test('renaming a folder preserves every draft/baseline and only remaps descendants', () => {
  const tabs = [tab('src/a.ts', 'disk', 'draft'), tab('src/nested/b.ts'), tab('src-other/c.ts')];
  const renamed = renameTabs(tabs, 'SRC', 'components');
  assert.deepEqual(renamed.map(tab => tab.path), ['components/a.ts', 'components/nested/b.ts', 'src-other/c.ts']);
  assert.equal(renamed[0].text, 'draft'); assert.equal(renamed[0].baseline, 'disk');
  assert.equal(tabDirty(renamed[0]), true); assert.equal(renamed[0].document, tabs[0].document);
  assert.equal(renamedPath('src/a.ts', 'src/a.ts', 'src/new.ts'), 'src/new.ts');
});
