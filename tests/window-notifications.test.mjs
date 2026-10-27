import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = async file => ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const logUrl = url(await compile('../src/log-utils.ts'));
const errors = await import(url((await compile('../src/operation-error.ts')).replace("'./log-utils'", JSON.stringify(logUrl))));

test('native window context chooses close operation without changing main exit routing', () => {
  assert.equal(errors.closeOperation('main', 'editor-close'), undefined);
  assert.equal(errors.closeOperation('quick-editor', 'editor-close'), 'editor_close');
  assert.equal(errors.closeOperation('main', 'app-close-requested'), 'shutdown_app');
  assert.equal(errors.closeOperation('quick-editor', 'app-close-requested'), 'shutdown_app');
  assert.equal(errors.closeOperation('logs-123', 'app-close-requested'), undefined);
});

test('close listener is native-targeted and preserves both approval gates', async () => {
  const source = await readFile(new URL('../src/EditorWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /target: \{ kind: 'WebviewWindow', label \}/);
  assert.match(source, /if \(!closeOperation\(label, event\)\) continue/);
  assert.ok(source.indexOf("'devflow-close-check'") < source.indexOf('await invoke(operation'));
  assert.ok(source.indexOf("'managed_service_count'") < source.indexOf('await invoke(operation'));
});

test('error text handles Rust strings, JS Errors and unknown objects safely', () => {
  assert.equal(errors.errorMessage(new Error('File changed on disk. Reload before saving.')), 'File changed on disk. Reload before saving.');
  assert.equal(errors.errorMessage('Port is already in use.'), 'Port is already in use.');
  assert.doesNotMatch(errors.errorMessage({ secret: 'private', detail: 'internal' }), /object Object|private|internal/);
});

test('floating service action replies return to the requesting subscribed window', async () => {
  const source = await readFile(new URL('../src/ProjectServiceControls.tsx', import.meta.url), 'utf8');
  assert.match(source, /subscribers.current.has\(payload.replyTo\)/);
  assert.match(source, /emitTo\(payload.replyTo, 'project-services-result'/);
  assert.match(source, /replyTo: getCurrentWindow\(\).label/);
  assert.match(source, /target: getCurrentWindow\(\).label/);
});

test('notification hook expires transient errors, deduplicates, preserves critical errors and cleans timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Minimal hook host: exercise the real effect and its cleanup without a DOM dependency.
  let state, effect, deps, cleanup;
  globalThis.__operationHookHost = {
    useState(initial) { state ??= initial; return [state, next => { state = typeof next === 'function' ? next(state) : next; }]; },
    useCallback(callback) { return callback; },
    useEffect(next, nextDeps) {
      if (!deps || nextDeps.some((value, i) => value !== deps[i])) { cleanup?.(); effect = next; deps = nextDeps; }
    },
  };
  const reactUrl = url('export const { useState, useCallback, useEffect } = globalThis.__operationHookHost;');
  const { useOperationError } = await import(url((await compile('../src/use-operation-error.ts')).replace("'react'", JSON.stringify(reactUrl))));
  const render = () => { effect = undefined; const result = useOperationError(); if (effect) cleanup = effect(); return result; };
  try {
    let [, setError] = render();
    setError('Cannot copy'); render();
    t.mock.timers.tick(4000);
    setError('Cannot copy'); render();
    t.mock.timers.tick(2500);
    assert.equal(render()[0], '');
    setError('Save failed; draft retained', true); render();
    t.mock.timers.tick(20000);
    assert.equal(render()[0], 'Save failed; draft retained');
    setError(''); render();
    assert.equal(render()[0], '');
    setError('Old project error'); render();
    setError(''); render();
    setError('New project error'); render();
    cleanup();
    t.mock.timers.tick(7000);
    assert.equal(state.message, 'New project error');
  } finally { cleanup?.(); delete globalThis.__operationHookHost; }
});
