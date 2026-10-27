import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/log-sharing.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createLogFrames, applyLogFrame } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
const entry = message => ({ projectId: 'p', serviceId: 'web', stream: 'stdout', message, receivedAt: 1 });
const project = { id: 'p', name: 'Project', root: 'D:/project', services: [] };

test('late view hydrates existing history; deltas preserve entry identity without reingestion', () => {
  const frame = createLogFrames(), a = entry('already running'), b = entry('next line');
  const initial = frame([a], true, project, ['p::web'], []);
  let rows = applyLogFrame([], 0, initial);
  const next = frame([a, b], false, project, ['p::web'], []);
  assert.equal(next.rows.length, 1);
  rows = applyLogFrame(rows, initial.revision, next);
  assert.deepEqual(rows.map(row => row.entry.message), ['already running', 'next line']);
  assert.equal(rows[0].entry, a);
  assert.deepEqual(next.active, ['p::web']);
});

test('clear and retention removals propagate, including identical lines without sequences', () => {
  const frame = createLogFrames(), a = entry('same'), b = entry('same'), c = entry('latest');
  const initial = frame([a, b], true, project, [], []);
  assert.notEqual(initial.rows[0].id, initial.rows[1].id);
  const next = frame([b, c], false, project, [], []);
  assert.deepEqual(next.removed, [initial.rows[0].id]);
  assert.deepEqual(applyLogFrame(initial.rows, initial.revision, next).map(row => row.entry), [b, c]);
  const cleared = frame([], false, project, [], []);
  assert.equal(applyLogFrame(applyLogFrame(initial.rows, initial.revision, next), next.revision, cleared).length, 0);
});

test('status-only frames contain no duplicate rows; gaps require a fresh snapshot', () => {
  const frame = createLogFrames(), a = entry('line');
  const initial = frame([a], true, project, ['p::web'], []);
  const status = frame([a], false, project, [], ['p::web']);
  assert.deepEqual(status.rows, []);
  assert.deepEqual(status.stopping, ['p::web']);
  const next = frame([a], false, project, [], []);
  assert.equal(applyLogFrame(initial.rows, initial.revision, next), undefined);
  const reset = frame([a], true, project, [], []);
  assert.deepEqual(applyLogFrame([], initial.revision, reset), reset.rows);
  assert.equal(applyLogFrame(initial.rows, status.revision, initial), initial.rows);
});
