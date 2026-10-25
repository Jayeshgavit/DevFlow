import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/project-store.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { ProjectStore } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const project = { id: 'p1', name: 'Workspace', root: 'C:\\work', services: [] };

test('load failure blocks edits and every persistence path', async () => {
  let writes = 0;
  const store = new ProjectStore(async () => { throw new Error('invalid JSON'); }, async () => { writes += 1; }, () => {});
  await assert.rejects(store.load(), /invalid JSON/);
  assert.equal(store.current.status, 'failed');
  assert.equal(store.current.projects.length, 0);
  assert.throws(() => store.edit(() => [project]), /Retry Load/);
  assert.throws(() => store.save(), /Retry Load/);
  assert.throws(() => store.updateAndSave(() => [project]), /Retry Load/);
  assert.equal(writes, 0);
});

test('successful retry restores saved projects and permits writes', async () => {
  let reads = 0;
  const saved = [];
  const store = new ProjectStore(async () => { if (++reads === 1) throw new Error('temporary read error'); return [project]; }, async projects => { saved.push(projects); }, () => {});
  await assert.rejects(store.load(), /temporary read error/);
  assert.deepEqual(await store.load(), [project]);
  assert.equal(store.current.status, 'ready');
  store.edit(projects => projects.map(item => ({ ...item, name: 'Edited' })));
  await store.save();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0].name, 'Edited');
  assert.equal(store.current.dirty, false);
});

test('an edit during a pending save remains unsaved until the next write', async () => {
  let release;
  const firstWrite = new Promise(resolve => { release = resolve; });
  const saved = [];
  const store = new ProjectStore(async () => [project], async projects => {
    saved.push(projects.map(item => ({ ...item })));
    if (saved.length === 1) await firstWrite;
  }, () => {});
  await store.load();
  const pending = store.save();
  await Promise.resolve();
  store.edit(projects => projects.map(item => ({ ...item, name: 'Newer edit' })));
  release();
  await pending;
  assert.equal(store.current.dirty, true);
  assert.equal(store.current.projects[0].name, 'Newer edit');
  await store.save();
  assert.deepEqual(saved.map(items => items[0].name), ['Workspace', 'Newer edit']);
  assert.equal(store.current.dirty, false);
});

test('queued project updates use the latest edited state', async () => {
  let release;
  const firstWrite = new Promise(resolve => { release = resolve; });
  const saved = [];
  const store = new ProjectStore(async () => [project], async projects => {
    saved.push(projects.map(item => ({ ...item })));
    if (saved.length === 1) await firstWrite;
  }, () => {});
  await store.load();
  const first = store.updateAndSave(items => [...items, { ...project, id: 'p2' }]);
  await Promise.resolve();
  store.edit(items => items.map(item => item.id === 'p1' ? { ...item, name: 'Newer edit' } : item));
  const second = store.updateAndSave(items => [...items, { ...project, id: 'p3' }]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(saved.at(-1).map(item => item.id), ['p1', 'p2', 'p3']);
  assert.equal(saved.at(-1)[0].name, 'Newer edit');
  assert.equal(store.current.dirty, false);
});
