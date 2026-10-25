import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/log-utils.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { classifyLog, parseHttp, groupLogs, formatEntry, serviceGroup, buildAiDebugPrompt, summarizeGroups } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('classifies status codes, stderr info, warnings, and successful builds semantically', () => {
  assert.equal(classifyLog('INFO: "GET /health HTTP/1.1" 200 OK'), 'success');
  assert.equal(classifyLog('GET /errors HTTP/1.1 200 OK'), 'success');
  assert.equal(classifyLog('INFO: "GET /login HTTP/1.1" 302 Found'), 'info');
  assert.equal(classifyLog('INFO: "GET /missing HTTP/1.1" 404 Not Found'), 'warning');
  assert.equal(classifyLog('INFO: "GET /crash HTTP/1.1" 503 Service Unavailable'), 'error');
  assert.equal(classifyLog('INFO: Uvicorn running on http://127.0.0.1:8000'), 'info');
  assert.equal(classifyLog('WARNING: connection is slow', null), 'warning');
  assert.equal(classifyLog('NameError: value is missing'), 'error');
  assert.equal(classifyLog('Vite ready in 120ms'), 'success');
});

test('summarizes only the selected project and service log groups', () => {
  const groups = groupLogs([
    { projectId: 'p1', serviceId: 'api', stream: 'stderr', message: 'GET /missing HTTP/1.1 404 Not Found', receivedAt: 1 },
    { projectId: 'p1', serviceId: 'worker', stream: 'stderr', message: 'WARNING: retrying', receivedAt: 2 },
    { projectId: 'p2', serviceId: 'api', stream: 'stdout', message: 'ERROR: failed', receivedAt: 3 },
  ]);
  const selected = groups.filter(group => group.entries[0].projectId === 'p1' && group.entries[0].serviceId === 'api');
  const summary = summarizeGroups(selected);
  assert.equal(summary.entries, 1);
  assert.equal(summary.counts.warning, 1);
  assert.equal(summary.counts.error, 0);
  assert.equal(summary.requests, 1);
});

test('extracts HTTP fields and request duration for highlighting', () => {
  const http = parseHttp('INFO: "POST /api/items HTTP/1.1" 201 Created 1.25s');
  assert.equal(http.method, 'POST');
  assert.equal(http.endpoint, '/api/items');
  assert.equal(http.status, 201);
  assert.equal(http.durationMs, 1250);
  assert.deepEqual(http.spans.map(span => span.kind), ['method', 'endpoint', 'status-success', 'duration']);
});

test('groups traceback lines without changing their message order or contents', () => {
  const messages = ['Traceback (most recent call last):', '  File "app.py", line 4, in run', '    raise ValueError("bad")', 'ValueError: bad'];
  const groups = groupLogs(messages.map((message, index) => ({ projectId: 'p1', serviceId: 'backend', stream: 'stderr', message, receivedAt: index })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].category, 'error');
  assert.deepEqual(groups[0].entries.map(entry => entry.message), messages);
  assert.match(formatEntry(groups[0].entries[0], 'Backend'), /\[Backend\] \[stderr\] Traceback/);
});

test('uses explicit service roles and IDs before custom service names', () => {
  assert.equal(serviceGroup({ id: 'svc-1', name: 'Web Layer', role: 'frontend' }), 'frontend');
  assert.equal(serviceGroup({ id: 'api-service', name: 'Application', role: 'worker' }), 'backend');
  assert.equal(serviceGroup({ id: 'svc-2', name: 'Custom Task Runner' }), null);
});

test('AI prompt includes relevant service context and best-effort masks common secrets', () => {
  const service = { id: 'api-service', name: 'Custom API', role: 'backend', cwd: 'C:\\work\\service', program: 'node', args: ['server.js', '--api-key', 'value123'] };
  const entry = { projectId: 'p1', serviceId: 'api-service', stream: 'stderr', message: 'ERROR: API_KEY=value456', receivedAt: 0 };
  const prompt = buildAiDebugPrompt({ name: 'Sample', root: 'C:\\work\\sample' }, [service], [entry]);
  assert.match(prompt, /Custom API \(backend\)/);
  assert.match(prompt, /\[stderr\] ERROR: API_KEY=\[redacted\]/);
  assert.doesNotMatch(prompt, /value123|value456/);
  assert.match(prompt, /best effort/i);
});
