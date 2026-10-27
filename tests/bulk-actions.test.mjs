import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const options = { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } };
const typesSource = await readFile(new URL('../src/types.ts', import.meta.url), 'utf8');
const typesJs = ts.transpileModule(typesSource, options).outputText;
const typesUrl = `data:text/javascript;base64,${Buffer.from(typesJs).toString('base64')}`;
const logJs = ts.transpileModule(await readFile(new URL('../src/log-utils.ts', import.meta.url), 'utf8'), options).outputText;
const logUrl = `data:text/javascript;base64,${Buffer.from(logJs).toString('base64')}`;
const errorJs = ts.transpileModule(await readFile(new URL('../src/operation-error.ts', import.meta.url), 'utf8'), options).outputText.replace("'./log-utils'", JSON.stringify(logUrl));
const errorUrl = `data:text/javascript;base64,${Buffer.from(errorJs).toString('base64')}`;
const source = await readFile(new URL('../src/bulk-actions.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, options).outputText.replace("from './types';", `from '${typesUrl}';`).replace("'./operation-error'", JSON.stringify(errorUrl));
const { runBulkAction } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

const services = ['web', 'api', 'worker'].map(id => ({ id, name: id, cwd: 'C:\\work', program: 'node', args: [] }));

test('Start All skips running and starting services and continues after one launch failure', async () => {
  const executed = [];
  const progress = [];
  const results = await runBulkAction({
    mode: 'start', projectId: 'p1', services,
    getActive: async () => ['p1::web'],
    isStarting: key => key === 'p1::api',
    execute: async service => { executed.push(service.id); throw new Error('Port unavailable'); },
    onProgress: (key, result) => progress.push([key, result.step]),
  });
  assert.deepEqual(executed, ['worker']);
  assert.deepEqual(Object.values(results).map(result => result.step), ['skipped', 'skipped', 'failed']);
  assert.ok(progress.some(([key, step]) => key === 'p1::worker' && step === 'starting'));
});

test('Start All attempts later services after an earlier failure', async () => {
  const executed = [];
  const results = await runBulkAction({
    mode: 'start', projectId: 'p1', services,
    getActive: async () => [], isStarting: () => false,
    execute: async service => { executed.push(service.id); if (service.id === 'web') throw new Error('Invalid executable'); },
    onProgress: () => {},
  });
  assert.deepEqual(executed, ['web', 'api', 'worker']);
  assert.deepEqual(Object.values(results).map(result => result.step), ['failed', 'launched', 'launched']);
});

test('Stop All waits for confirmed stops and reports partial failures', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const executed = [];
  const progress = [];
  const operation = runBulkAction({
    mode: 'stop', projectId: 'p1', services,
    getActive: async () => ['p1::web'],
    isStarting: key => key === 'p1::api',
    execute: async service => {
      executed.push(service.id);
      if (service.id === 'web') await pending;
      if (service.id === 'api') throw new Error('Cleanup timed out');
    },
    onProgress: (key, result) => progress.push([key, result.step]),
  });
  await Promise.resolve();
  assert.ok(progress.some(([key, step]) => key === 'p1::web' && step === 'stopping'));
  assert.ok(!progress.some(([, step]) => step === 'stopped'));
  release();
  const results = await operation;
  assert.deepEqual(executed, ['web', 'api']);
  assert.deepEqual(Object.values(results).map(result => result.step), ['stopped', 'failed', 'skipped']);
});

test('state lookup failure is reported per service and does not launch blindly', async () => {
  let launches = 0;
  const results = await runBulkAction({
    mode: 'start', projectId: 'p1', services,
    getActive: async () => { throw new Error('Registry unavailable'); },
    isStarting: () => false,
    execute: async () => { launches += 1; },
    onProgress: () => {},
  });
  assert.equal(launches, 0);
  assert.deepEqual(Object.values(results).map(result => result.step), ['failed', 'failed', 'failed']);
});

test('Stop cancels later queued bulk starts without launching them or retrying', async () => {
  const cancelled = new Set();
  const executed = [];
  const results = await runBulkAction({
    mode: 'start', projectId: 'p1', services, getActive: async () => [], isStarting: () => false,
    isCancelled: key => cancelled.has(key),
    execute: async service => { executed.push(service.id); cancelled.add('p1::api'); cancelled.add('p1::worker'); }, onProgress: () => {},
  });
  assert.deepEqual(executed, ['web']);
  assert.deepEqual(Object.values(results).map(result => result.step), ['launched', 'skipped', 'skipped']);
  assert.match(results['p1::api'].detail, /cancelled by Stop/);
});

test('Stop cancellation during an asynchronous registry lookup prevents the launch', async () => {
  let cancelled = false, launches = 0;
  const results = await runBulkAction({
    mode: 'start', projectId: 'p1', services,
    getActive: async () => { cancelled = true; return []; }, isStarting: () => false, isCancelled: () => cancelled,
    execute: async () => { launches++; }, onProgress: () => {},
  });
  assert.equal(launches, 0);
  assert.ok(Object.values(results).every(result => result.step === 'skipped'));
});

test('start cancellation never suppresses a requested stop', async () => {
  const stopped = [];
  await runBulkAction({
    mode: 'stop', projectId: 'p1', services, getActive: async () => ['p1::web', 'p1::api'],
    isStarting: () => false, isCancelled: () => true,
    execute: async service => { stopped.push(service.id); }, onProgress: () => {},
  });
  assert.deepEqual(stopped, ['web', 'api']);
});
