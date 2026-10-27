import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/log-utils.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { logCopyGroups, errorContext, parseErrorLocation, logStopServices, classifyLog, parseHttp, groupLogs, formatEntry, serviceGroup, buildAiDebugPrompt, summarizeGroups, appendLog, appendLogs, logBytes, createSourceDeduper, createAnsiLogNormalizer, redactForSharing, MAX_SERVICE_LOGS, MAX_PROJECT_LOGS, MAX_SESSION_LOGS, MAX_SERVICE_LOG_BYTES, MAX_PROJECT_LOG_BYTES, MAX_SESSION_LOG_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

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

test('retains recent entries per service without changing the remaining order', () => {
  let entries = [];
  for (let index = 0; index <= MAX_SERVICE_LOGS; index++) entries = appendLog(entries, { projectId: 'p1', serviceId: 'web', stream: 'stdout', message: String(index), receivedAt: index });
  entries = appendLog(entries, { projectId: 'p1', serviceId: 'api', stream: 'stderr', message: 'other', receivedAt: MAX_SERVICE_LOGS + 2 });
  assert.equal(entries.length, MAX_SERVICE_LOGS + 1);
  assert.equal(entries[0].message, '1');
  assert.equal(entries.at(-1).message, 'other');
});

test('bounds each project and the whole session', () => {
  let entries = [];
  for (let index = 0; index < MAX_PROJECT_LOGS + 200; index++) entries = appendLog(entries, { projectId: 'p1', serviceId: `service-${index % 5}`, stream: 'stdout', message: String(index), receivedAt: index });
  assert.equal(entries.length, MAX_PROJECT_LOGS);
  for (let index = 0; index < MAX_PROJECT_LOGS + 200; index++) entries = appendLog(entries, { projectId: 'p2', serviceId: `service-${index % 5}`, stream: 'stdout', message: String(index), receivedAt: index });
  assert.equal(entries.length, MAX_SESSION_LOGS);
  assert.equal(entries.filter(entry => entry.projectId === 'p1').length, MAX_PROJECT_LOGS);
  assert.equal(entries.filter(entry => entry.projectId === 'p2').length, MAX_PROJECT_LOGS);
});

test('shared log text uses best-effort masking', () => {
  const text = redactForSharing('API_KEY=value123 Authorization: Bearer secret456 https://user:pass@example.com');
  assert.doesNotMatch(text, /value123|secret456|user:pass/);
  assert.match(text, /\[redacted\]/);
});

test('flood of identical tracebacks collapses UI groups without losing source lines or distinct errors', () => {
  const trace = ['Traceback (most recent call last):', '  File "app.py", line 4, in run', '    raise ValueError("bad")', 'ValueError: bad'];
  const entries = Array.from({ length: 1000 }, (_, repeat) => trace.map((message, index) => ({ projectId: 'p', serviceId: 'api', stream: 'stderr', runId: 'run1', message, receivedAt: repeat * 4 + index }))).flat();
  entries.push({ projectId: 'p', serviceId: 'api', stream: 'stderr', runId: 'run1', message: 'TypeError: different', receivedAt: 4000 });
  const groups = groupLogs(entries);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].repeatCount, 1000);
  assert.equal(groups[0].entries.length, 4000);
  assert.equal(groups[0].entries[0].receivedAt, 0);
  assert.equal(groups[0].latestAt, 3996);
  assert.deepEqual(groups[0].sample.map(row => row.message), trace);
  assert.equal(groups[1].entries[0].message, 'TypeError: different');
  assert.equal(summarizeGroups(groups).entries, 4001);
});

test('source identity rejects duplicate delivery but preserves real repeated output and independent streams/runs', () => {
  const accept = createSourceDeduper();
  const base = { projectId: 'p', serviceId: 'api', runId: 'run1', stream: 'stderr', message: 'ERROR: same', sequence: 1 };
  assert.equal(accept(base), true); assert.equal(accept(base), false);
  assert.equal(accept({ ...base, sequence: 2 }), true);
  assert.equal(accept({ ...base, stream: 'stdout' }), true);
  assert.equal(accept({ ...base, runId: 'run2' }), true);
  assert.equal(accept({ ...base, serviceId: 'other' }), true);
});

test('memory budgets bound oversized floods per service, project and session without mutating input', () => {
  const incoming = Array.from({ length: 3000 }, (_, index) => ({ projectId: `p${index % 3}`, serviceId: `s${index % 9}`, stream: 'stderr', message: 'E'.repeat(16384), receivedAt: index }));
  const retained = appendLogs([], incoming);
  assert.ok(retained.reduce((sum, line) => sum + logBytes(line), 0) <= MAX_SESSION_LOG_BYTES);
  for (let project = 0; project < 3; project++) assert.ok(retained.filter(line => line.projectId === `p${project}`).reduce((sum, line) => sum + logBytes(line), 0) <= MAX_PROJECT_LOG_BYTES);
  for (let service = 0; service < 9; service++) assert.ok(retained.filter(line => line.serviceId === `s${service}`).reduce((sum, line) => sum + logBytes(line), 0) <= MAX_SERVICE_LOG_BYTES);
  assert.equal(retained.at(-1), incoming.at(-1)); assert.equal(incoming.length, 3000);
});

test('repeat grouping never crosses launch, service or stream boundaries', () => {
  const base = { projectId: 'p', serviceId: 'api', stream: 'stderr', runId: 'run1', message: 'ValueError: same', receivedAt: 1 };
  const groups = groupLogs([base, { ...base, receivedAt: 2 }, { ...base, runId: 'run2' }, { ...base, serviceId: 'worker' }, { ...base, stream: 'stdout' }]);
  assert.equal(groups.length, 4); assert.equal(groups[0].repeatCount, 2);
});

test('source ANSI state is isolated across launches', () => {
  const normalize = createAnsiLogNormalizer();
  const base = { projectId: 'p', serviceId: 'api', stream: 'stderr', receivedAt: 1 };
  normalize({ ...base, runId: 'old', message: '\x1b[31mred' });
  const fresh = normalize({ ...base, runId: 'new', message: 'plain' });
  assert.equal(fresh.message, 'plain'); assert.deepEqual(fresh.ansiSpans, []);
});

test('log stop scopes include all role matches while all also includes unclassified workers', () => {
  const services = [
    { id: 'web1', name: 'Web', role: 'frontend' },
    { id: 'custom-web', name: 'Client', role: 'frontend' },
    { id: 'api', name: 'API', role: 'backend' },
    { id: 'worker', name: 'Queue worker', role: 'other' },
  ];
  assert.deepEqual(logStopServices(services, 'frontend').map(service => service.id), ['web1', 'custom-web']);
  assert.deepEqual(logStopServices(services, 'backend').map(service => service.id), ['api']);
  assert.deepEqual(logStopServices(services, 'both').map(service => service.id), ['web1', 'custom-web', 'api']);
  assert.deepEqual(logStopServices(services, 'all').map(service => service.id), ['web1', 'custom-web', 'api', 'worker']);
  assert.equal(services.length, 4);
  assert.equal(logStopServices([], 'all').length, 0);
});


test('error locations accept only explicit files under the selected Windows project', () => {
  const root = String.raw`C:\work\project`;
  assert.deepEqual(parseErrorLocation(String.raw`    at run (C:\work\project\src\app.ts:42:7)`, root), { path: 'src/app.ts', line: 42 });
  assert.deepEqual(parseErrorLocation('  File "C:/work/project/api/main.py", line 8, in run', root), { path: 'api/main.py', line: 8 });
  assert.equal(parseErrorLocation(String.raw`at C:\work\project-other\app.ts:2:1`, root), null);
  assert.equal(parseErrorLocation(String.raw`at C:\work\project\..\secrets.ts:2:1`, root), null);
  assert.equal(parseErrorLocation('at src/app.ts:2:1', root), null);
  assert.equal(parseErrorLocation(String.raw`at C:\work\project\app.ts:0:1`, root), null);
  assert.equal(parseErrorLocation('GET http://localhost:3000/app.ts:2:1', root), null);
});

test('error context stays chronological, deduplicated, bounded, and inside the service run', () => {
  const lines = Array.from({ length: 1000 }, (_, index) => ({ projectId: 'p', serviceId: 'api', stream: 'stdout', runId: 'run', message: `line ${index}`, receivedAt: index }));
  lines[48] = { ...lines[48], projectId: 'other' };
  lines[49] = { ...lines[49], serviceId: 'frontend' };
  lines[52] = { ...lines[52], runId: 'previous' };
  assert.deepEqual(errorContext(lines, [lines[50], lines[51]]).map(entry => entry.receivedAt), [50, 51, 53]);
  assert.equal(errorContext(lines, lines).length, 200);
  assert.deepEqual(errorContext(lines, []).map(entry => entry.receivedAt), []);
  const bounded = errorContext(lines, lines);
  assert.equal(new Set(bounded).size, bounded.length);
  assert.ok(bounded.every((entry, index) => !index || entry.receivedAt > bounded[index - 1].receivedAt));
});


test('every named copy scope isolates projects and retains the advertised role, severity, or filter', () => {
  const project = { id: 'p', services: [{ id: 'ui', name: 'Portal', role: 'frontend' }, { id: 'api', name: 'Python', role: 'backend' }] };
  const entries = [
    { projectId: 'p', serviceId: 'ui', message: 'ready' },
    { projectId: 'p', serviceId: 'api', message: 'Error: backend failed' },
    { projectId: 'p', serviceId: 'ui', message: 'Error: frontend failed' },
    { projectId: 'other', serviceId: 'ui', message: 'Error: unrelated secret' },
  ].map((line, receivedAt) => ({ ...line, receivedAt, stream: 'stdout' }));
  const groups = groupLogs(entries), filtered = [groups[1], groups[3]];
  const expected = { all: [0, 1, 2], frontend: [0, 2], backend: [1], errors: [1, 2], 'frontend-errors': [2], 'backend-errors': [1], current: [1] };
  for (const [kind, indices] of Object.entries(expected)) {
    assert.deepEqual(logCopyGroups(project, groups, filtered, kind).flatMap(group => group.entries).map(entry => entry.receivedAt), indices, kind);
  }
  assert.deepEqual(logCopyGroups({ ...project, services: [] }, groups, filtered, 'frontend'), []);
});
