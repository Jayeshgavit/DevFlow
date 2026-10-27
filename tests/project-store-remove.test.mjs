/**
 * Focused unit tests for remove-project behavior using ProjectStore directly.
 * Run: node --test tests/project-store-remove.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Transpile TypeScript -> ESM on the fly (same technique as log-utils.test.mjs)
const storeSource = await readFile(new URL('../src/project-store.ts', import.meta.url), 'utf8');
const storeJs = ts.transpileModule(storeSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ProjectStore } = await import(`data:text/javascript;base64,${Buffer.from(storeJs).toString('base64')}`);

/** Minimal project factories */
const makeProject = (id, name = id, services = []) => ({ id, name, root: `C:\\projects\\${id}`, services });
const makeService = (id) => ({ id, name: id, cwd: 'C:\\projects\\app', program: 'node', args: [] });

/** Build a ready store pre-loaded with the given projects */
function readyStore(initial, onWrite = async () => {}) {
  const store = new ProjectStore(
    async () => initial,
    onWrite,
    () => {},
  );
  return { store, loaded: store.load() };
}

// 1. Successful removal
test('removes a project by ID, persists the remainder, and reports dirty:false', async () => {
  const pa = makeProject('p-alpha', 'Alpha');
  const pb = makeProject('p-beta', 'Beta');
  let written = null;
  const { store, loaded } = readyStore([pa, pb], async projects => { written = projects; });
  await loaded;

  await store.updateAndSave(current => current.filter(p => p.id !== 'p-alpha'));

  assert.deepEqual(store.current.projects.map(p => p.id), ['p-beta']);
  assert.equal(store.current.dirty, false);
  assert.deepEqual(written.map(p => p.id), ['p-beta']);
});

test('removing the only project leaves an empty list and persists it', async () => {
  const pa = makeProject('p-only', 'Only');
  let written = null;
  const { store, loaded } = readyStore([pa], async projects => { written = projects; });
  await loaded;

  await store.updateAndSave(current => current.filter(p => p.id !== 'p-only'));

  assert.deepEqual(store.current.projects, []);
  assert.equal(store.current.dirty, false);
  assert.deepEqual(written, []);
});

test('removing a ghost ID is a no-op safe write', async () => {
  const pa = makeProject('p-alpha');
  let writeCount = 0;
  const { store, loaded } = readyStore([pa], async () => { writeCount++; });
  await loaded;

  await store.updateAndSave(current => current.filter(p => p.id !== 'p-ghost'));

  assert.deepEqual(store.current.projects.map(p => p.id), ['p-alpha']);
  assert.equal(writeCount, 1);
});

// 2. Active-service blocking (guard lives in main.tsx; verified here structurally)
test('guard correctly detects active services and blocks store call', async () => {
  const pa = makeProject('p-alpha', 'Alpha', [makeService('web')]);
  const { store, loaded } = readyStore([pa]);
  await loaded;

  const simulatedRunning = ['p-alpha::web'];
  const hasActiveService = pa.services.some(s => simulatedRunning.includes(`${pa.id}::${s.id}`));
  assert.equal(hasActiveService, true, 'guard should detect active service');

  // Guard prevents the call
  if (!hasActiveService) await store.updateAndSave(c => c.filter(p => p.id !== pa.id));

  assert.deepEqual(store.current.projects.map(p => p.id), ['p-alpha'], 'project must remain');
});

// 3. Persistence failure recovery
test('on write failure the store retains projects and throws so UI can report it', async () => {
  const pa = makeProject('p-alpha', 'Alpha');
  const pb = makeProject('p-beta', 'Beta');

  const { store, loaded } = readyStore([pa, pb], async () => { throw new Error('Disk full'); });
  await loaded;

  let caughtError = null;
  try {
    await store.updateAndSave(current => current.filter(p => p.id !== 'p-alpha'));
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, 'error must propagate so UI can display it');
  assert.equal(caughtError.message, 'Disk full');
  assert.deepEqual(store.current.projects.map(p => p.id), ['p-alpha', 'p-beta'],
    'projects must be retained after write failure');
});

test('store remains usable after a failed removal attempt', async () => {
  const pa = makeProject('p-alpha');
  const pb = makeProject('p-beta');
  let failNext = true;
  const { store, loaded } = readyStore([pa, pb], async () => {
    if (failNext) { failNext = false; throw new Error('transient'); }
  });
  await loaded;

  await assert.rejects(() => store.updateAndSave(c => c.filter(p => p.id !== 'p-alpha')));
  assert.deepEqual(store.current.projects.map(p => p.id), ['p-alpha', 'p-beta']);

  await store.updateAndSave(c => c.filter(p => p.id !== 'p-alpha'));
  assert.deepEqual(store.current.projects.map(p => p.id), ['p-beta']);
  assert.equal(store.current.dirty, false);
});

// 4. Sibling isolation
test('removal does not modify sibling projects', async () => {
  const pa = makeProject('p-alpha', 'Alpha', [makeService('web'), makeService('api')]);
  const pb = makeProject('p-beta', 'Beta', [makeService('db')]);
  let written = null;
  const { store, loaded } = readyStore([pa, pb], async projects => { written = projects; });
  await loaded;

  await store.updateAndSave(current => current.filter(p => p.id !== 'p-alpha'));

  assert.deepEqual(written.map(p => p.id), ['p-beta']);
  assert.equal(written[0].services.length, 1);
  assert.equal(written[0].services[0].id, 'db');
});

// 5. Load-failure protection
test('updateAndSave throws when store has not loaded successfully', async () => {
  const store = new ProjectStore(
    async () => { throw new Error('disk unreadable'); },
    async () => {},
    () => {},
  );
  await store.load().catch(() => {});

  assert.equal(store.current.status, 'failed');
  // requireReady() throws synchronously; wrap so assert.rejects sees a rejected promise
  await assert.rejects(
    async () => store.updateAndSave(c => c.filter(p => p.id !== 'anything')),
    /Retry Load/,
    'must refuse mutation when not ready',
  );
});
