import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/editor-session.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { closeTab, tabDirty, sessionDirty, tabKey, renamedPath, renameTabs } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
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
