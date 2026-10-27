import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const options = { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } };
const url = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, options).outputText).toString('base64')}`;
const typesUrl = url(await readFile(new URL('../src/types.ts', import.meta.url), 'utf8'));
const source = await readFile(new URL('../src/project-service-state.ts', import.meta.url), 'utf8');
const { projectServiceState, stopAllConfirmation } = await import(url(source.replaceAll("from './types';", `from '${typesUrl}';`)));
const project = { id: 'editor', name: 'Editor project', services: [{ id: 'web', name: 'Web' }, { id: 'api', name: 'API' }] };
const state = (running = [], starting = [], stopping = [], errors = {}) => projectServiceState(project, running, starting, stopping, errors);

test('project status ignores services and errors belonging to other projects', () => {
  assert.deepEqual(state(['other::web'], ['other::api'], ['other::web'], { 'other::api': 'failed' }), {
    projectId: 'editor', status: 'Stopped', active: false, pending: false, errors: [],
  });
});
test('starting and stopping disable duplicate actions and keep Stop All available after completion', () => {
  assert.equal(state([], ['editor::web']).status, 'Starting');
  assert.equal(state([], ['editor::web']).pending, true);
  assert.equal(state([], [], ['editor::web']).active, true);
  assert.equal(state([], [], ['editor::web']).pending, true);
  assert.equal(state([], [], ['editor::web']).status, 'Stopping');
  assert.equal(state(['editor::web', 'editor::api']).status, 'Running');
  assert.equal(state(['editor::web', 'editor::api']).pending, false);
});
test('partial and failed launches preserve named actionable errors', () => {
  const errors = { 'editor::api': 'Port 8000 is in use. Change the configured port.' };
  assert.equal(state(['editor::web'], [], [], errors).status, 'Partial');
  assert.equal(state([], [], [], errors).status, 'Error');
  assert.deepEqual(state([], [], [], errors).errors, ['API: Port 8000 is in use. Change the configured port.']);
  assert.equal(state(['editor::web']).status, 'Partial');
});
test('a project with no configured services is stopped', () => {
  assert.equal(projectServiceState({ ...project, services: [] }, [], [], [], {}).status, 'Stopped');
});
test('failed cleanup allows Stop All retry while an actual stop request remains disabled', () => {
  const errors = { 'editor::web': 'Could not confirm cleanup. Retry Stop.' };
  const retry = projectServiceState(project, ['editor::web'], [], [], errors, ['editor::web']);
  assert.equal(retry.active, true);
  assert.equal(retry.pending, false);
  assert.equal(retry.status, 'Partial');
  assert.equal(projectServiceState(project, ['editor::web'], [], ['editor::web'], errors, ['editor::web']).pending, true);
});
test('stop confirmation requires an explicit action and identifies the project', () => {
  let calls = 0;
  const confirmation = stopAllConfirmation(project, () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(confirmation.title, 'Stop all services in Editor project?');
  assert.equal(confirmation.confirmText, 'Force stop all');
  assert.equal(confirmation.destructive, true);
  confirmation.action();
  assert.equal(calls, 1);
});
