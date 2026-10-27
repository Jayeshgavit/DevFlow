import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/project-store.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ProjectStore } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const service = { id: 'web', name: 'Web', cwd: 'C:\\work', program: 'node', args: ['server.js'] };
const project = { id: 'p1', name: 'Original', root: 'C:\\work', services: [service] };
const other = { id: 'p2', name: 'Other', root: 'C:\\other', services: [] };

test('rename trims and persists only the selected display name', async () => {
  let written;
  const store = new ProjectStore(async () => [project, other], async projects => { written = projects; }, () => {});
  await store.load();

  await store.renameProject('p1', '  New name  ');

  assert.deepEqual(written, [{ ...project, name: 'New name' }, other]);
  assert.deepEqual(store.current.projects, written);
  assert.equal(store.current.dirty, false);
  assert.equal(store.current.projects[0].services[0], service);
});

test('empty names and missing projects do not write', async () => {
  let writes = 0;
  const store = new ProjectStore(async () => [project], async () => { writes += 1; }, () => {});
  await store.load();

  assert.throws(() => store.renameProject('p1', '  '), /cannot be empty/);
  await assert.rejects(store.renameProject('missing', 'New'), /no longer exists/);
  assert.equal(writes, 0);
  assert.deepEqual(store.current.projects, [project]);
});

test('failed save leaves the displayed name unchanged and permits retry', async () => {
  let fail = true;
  const store = new ProjectStore(async () => [project], async () => {
    if (fail) { fail = false; throw new Error('Disk full'); }
  }, () => {});
  await store.load();

  await assert.rejects(store.renameProject('p1', 'New'), /Disk full/);
  assert.deepEqual(store.current.projects, [project]);
  await store.renameProject('p1', 'New');
  assert.equal(store.current.projects[0].name, 'New');
});

test('rename is blocked after a failed load', async () => {
  let writes = 0;
  const store = new ProjectStore(async () => { throw new Error('Invalid JSON'); }, async () => { writes += 1; }, () => {});
  await assert.rejects(store.load(), /Invalid JSON/);
  assert.throws(() => store.renameProject('p1', 'New'), /Retry Load/);
  assert.equal(writes, 0);
});

test('service edits made while rename writes remain dirty', async () => {
  let release;
  const pendingWrite = new Promise(resolve => { release = resolve; });
  const store = new ProjectStore(async () => [project], async () => { await pendingWrite; }, () => {});
  await store.load();
  const rename = store.renameProject('p1', 'New');
  await Promise.resolve();
  store.edit(projects => projects.map(item => ({ ...item, services: [{ ...service, program: 'npm' }] })));
  release();
  await rename;
  assert.equal(store.current.projects[0].name, 'New');
  assert.equal(store.current.projects[0].services[0].program, 'npm');
  assert.equal(store.current.dirty, true);
});
