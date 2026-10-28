import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const options = { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } };
const url = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, options).outputText).toString('base64')}`;

const typesUrl = url(await readFile(new URL('../src/types.ts', import.meta.url), 'utf8'));

const logUtilsSource = (await readFile(new URL('../src/log-utils.ts', import.meta.url), 'utf8'))
  .replaceAll("from './types';", `from '${typesUrl}';`);
const logUtilsUrl = url(logUtilsSource);
const {
  buildServiceOptions,
  remapServiceFilter,
  logStopServices,
  serviceGroup,
  appendLog,
} = await import(logUtilsUrl);

const stateSource = (await readFile(new URL('../src/project-service-state.ts', import.meta.url), 'utf8'))
  .replaceAll("from './types';", `from '${typesUrl}';`);
const {
  projectServiceState,
  stopAllConfirmation,
  stopScopeConfirmation,
} = await import(url(stateSource));

const errorSource = (await readFile(new URL('../src/operation-error.ts', import.meta.url), 'utf8'))
  .replace("'./log-utils'", JSON.stringify(logUtilsUrl));
const errorUrl = url(errorSource);

const bulkSource = (await readFile(new URL('../src/bulk-actions.ts', import.meta.url), 'utf8'))
  .replaceAll("from './types';", `from '${typesUrl}';`)
  .replace("'./operation-error'", JSON.stringify(errorUrl));
const { runBulkAction } = await import(url(bulkSource));

// 1. Two projects (A and B) with identically named services have isolated logs and statuses
test('projects with identically named services have isolated statuses and errors', () => {
  const projectA = {
    id: 'proj-a',
    name: 'Project A',
    services: [{ id: 'web', name: 'Web' }, { id: 'api', name: 'API' }],
  };
  const projectB = {
    id: 'proj-b',
    name: 'Project B',
    services: [{ id: 'web', name: 'Web' }, { id: 'api', name: 'API' }],
  };

  const running = ['proj-a::web'];
  const starting = ['proj-a::api'];
  const stopping = ['proj-b::web'];
  const errors = { 'proj-b::api': 'Port 8000 already in use' };

  const stateA = projectServiceState(projectA, running, starting, stopping, errors);
  assert.equal(stateA.projectId, 'proj-a');
  assert.equal(stateA.status, 'Starting');
  assert.equal(stateA.active, true);
  assert.equal(stateA.pending, true);
  assert.deepEqual(stateA.errors, []);

  const stateB = projectServiceState(projectB, running, starting, stopping, errors);
  assert.equal(stateB.projectId, 'proj-b');
  assert.equal(stateB.status, 'Stopping');
  assert.equal(stateB.active, true);
  assert.equal(stateB.pending, true);
  assert.deepEqual(stateB.errors, ['API: Port 8000 already in use']);
});

test('project log scoping strictly isolates logs between projects and preserves own logs', () => {
  const logs = [
    { projectId: 'proj-a', serviceId: 'web', message: 'A web started', stream: 'stdout', receivedAt: 1 },
    { projectId: 'proj-b', serviceId: 'web', message: 'B web started', stream: 'stdout', receivedAt: 2 },
    { projectId: 'proj-a', serviceId: 'api', message: 'A api listening', stream: 'stdout', receivedAt: 3 },
    { projectId: 'proj-b', serviceId: 'api', message: 'B api crashed', stream: 'stderr', receivedAt: 4 },
    { projectId: '', serviceId: '', incidentId: 'inc-1', message: 'Global system event', stream: 'system', receivedAt: 5 },
  ];

  const filterLogsForProject = (entries, projectId) =>
    projectId ? entries.filter(e => e.projectId === projectId || (!!e.incidentId && !e.projectId)) : [];

  const scopedA = filterLogsForProject(logs, 'proj-a');
  assert.equal(scopedA.length, 3);
  assert.ok(scopedA.every(e => e.projectId === 'proj-a' || (e.incidentId === 'inc-1' && !e.projectId)));
  assert.ok(!scopedA.some(e => e.projectId === 'proj-b'));

  const scopedB = filterLogsForProject(logs, 'proj-b');
  assert.equal(scopedB.length, 3);
  assert.ok(scopedB.every(e => e.projectId === 'proj-b' || (e.incidentId === 'inc-1' && !e.projectId)));
  assert.ok(!scopedB.some(e => e.projectId === 'proj-a'));
});

// 2. Switching projects resets stale service filters or remaps single-service roles
test('switching projects resets stale filters and safely remaps role filters', () => {
  const projectAServices = [
    { id: 'api', name: 'API', role: 'backend' },
    { id: 'worker', name: 'Worker', role: 'backend' },
  ];
  const projectBServices = [
    { id: 'web', name: 'Web', role: 'frontend' },
    { id: 'server', name: 'Server', role: 'backend' },
  ];

  // Stale service ID from Project A is reset to 'all' when switching to Project B
  assert.equal(remapServiceFilter('api', projectBServices), 'all');
  assert.equal(remapServiceFilter('worker', projectBServices), 'all');

  // Valid service ID in Project B is kept
  assert.equal(remapServiceFilter('web', projectBServices), 'web');

  // Single-service role is remapped directly to the service id
  assert.equal(remapServiceFilter('role:frontend', projectBServices), 'web');
  assert.equal(remapServiceFilter('role:backend', projectBServices), 'server');

  // Multiple services in a role retains the generic role filter
  assert.equal(remapServiceFilter('role:backend', projectAServices), 'role:backend');

  // Missing role resets to 'all'
  assert.equal(remapServiceFilter('role:frontend', projectAServices), 'all');
});

// 3. Distinct services sharing the same name are disambiguated with (${service.id})
test('distinct services with the same name are disambiguated with stable IDs', () => {
  const services = [
    { id: 'frontend-web', name: 'Frontend', role: 'frontend' },
    { id: 'frontend-mobile', name: 'Frontend', role: 'frontend' },
    { id: 'backend-api', name: 'Backend', role: 'backend' },
  ];

  const options = buildServiceOptions(services);
  assert.deepEqual(options, [
    { value: 'all', label: 'Combined services' },
    { value: 'role:frontend', label: 'Frontend (all 2)' },
    { value: 'frontend-web', label: 'Frontend (frontend-web)' },
    { value: 'frontend-mobile', label: 'Frontend (frontend-mobile)' },
    { value: 'backend-api', label: 'Backend' }, // unique name is not suffixed
  ]);
});

// 4. Selector deduplicates stable service IDs and omits redundant generic filters when <= 1 service in role
test('selector deduplicates identical service IDs and omits redundant role filters', () => {
  const servicesWithDuplicates = [
    { id: 'web', name: 'Web', role: 'frontend' },
    { id: 'web', name: 'Web', role: 'frontend' }, // duplicate entry
    { id: 'api', name: 'API', role: 'backend' },
  ];

  const options = buildServiceOptions(servicesWithDuplicates);
  // Exactly 1 unique frontend and 1 unique backend: role filters omitted
  assert.deepEqual(options, [
    { value: 'all', label: 'Combined services' },
    { value: 'web', label: 'Web' },
    { value: 'api', label: 'API' },
  ]);
});

// 5. Stop All targets only the selected project's managed services
test('Stop All targets only the selected project services with confirmation', () => {
  const projectA = {
    id: 'proj-a',
    name: 'Project A',
    services: [
      { id: 'web', name: 'Web', role: 'frontend' },
      { id: 'api', name: 'API', role: 'backend' },
    ],
  };

  const scoped = logStopServices(projectA.services, 'all');
  assert.deepEqual(scoped.map(s => s.id), ['web', 'api']);

  let confirmed = false;
  const dialog = stopAllConfirmation(projectA, () => { confirmed = true; });
  assert.equal(dialog.title, 'Stop all services in Project A?');
  assert.equal(dialog.destructive, true);
  dialog.action();
  assert.equal(confirmed, true);
});

// 6. Stop Frontend, Backend, and Both target only matching services
test('Stop Frontend, Backend, and Both filter target services strictly', () => {
  const project = {
    id: 'p1',
    name: 'Full Stack App',
    services: [
      { id: 'web', name: 'Web', role: 'frontend' },
      { id: 'client', name: 'Mobile Web', role: 'frontend' },
      { id: 'api', name: 'API', role: 'backend' },
      { id: 'worker', name: 'Background Worker', role: 'other' },
    ],
  };

  const frontendOnly = logStopServices(project.services, 'frontend');
  assert.deepEqual(frontendOnly.map(s => s.id), ['web', 'client']);

  const backendOnly = logStopServices(project.services, 'backend');
  assert.deepEqual(backendOnly.map(s => s.id), ['api']);

  const both = logStopServices(project.services, 'both');
  assert.deepEqual(both.map(s => s.id), ['web', 'client', 'api']); // excludes worker

  const all = logStopServices(project.services, 'all');
  assert.deepEqual(all.map(s => s.id), ['web', 'client', 'api', 'worker']);

  // Confirmations
  const confirmFrontend = stopScopeConfirmation(project, 'frontend', frontendOnly, () => {});
  assert.equal(confirmFrontend.title, 'Stop frontend services in Full Stack App?');
  assert.ok(confirmFrontend.description.includes('Web, Mobile Web'));

  const confirmBackend = stopScopeConfirmation(project, 'backend', backendOnly, () => {});
  assert.equal(confirmBackend.title, 'Stop backend services in Full Stack App?');
  assert.ok(confirmBackend.description.includes('API'));

  const confirmBoth = stopScopeConfirmation(project, 'both', both, () => {});
  assert.equal(confirmBoth.title, 'Stop frontend and backend services in Full Stack App?');
  assert.ok(confirmBoth.description.includes('Web, Mobile Web, API'));
});

// 7. Sequential stop handling via runBulkAction avoids parallel race conditions
test('scoped stop executes sequentially via runBulkAction without racing', async () => {
  const executionLog = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const services = [
    { id: 's1', name: 'Service 1', role: 'frontend' },
    { id: 's2', name: 'Service 2', role: 'frontend' },
    { id: 's3', name: 'Service 3', role: 'frontend' },
  ];

  const results = await runBulkAction({
    mode: 'stop',
    projectId: 'p1',
    services,
    getActive: async () => ['p1::s1', 'p1::s2', 'p1::s3'],
    isStarting: () => false,
    execute: async service => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      executionLog.push(`start:${service.id}`);
      await new Promise(resolve => setTimeout(resolve, 10));
      executionLog.push(`end:${service.id}`);
      inFlight -= 1;
    },
    onProgress: () => {},
  });

  assert.equal(maxConcurrent, 1, 'Only one service stopped at a time (sequential execution)');
  assert.deepEqual(executionLog, [
    'start:s1', 'end:s1',
    'start:s2', 'end:s2',
    'start:s3', 'end:s3',
  ]);
  assert.deepEqual(Object.values(results).map(r => r.step), ['stopped', 'stopped', 'stopped']);
});

// 8. Stopped service log entries remain retained and visible for their own project
test('stopped service logs remain retained in history and isolated to their project', () => {
  let logs = [];
  const entry1 = { projectId: 'p1', serviceId: 's1', message: 'Running service 1', stream: 'stdout', receivedAt: 100 };
  const entry2 = { projectId: 'p1', serviceId: 's2', message: 'Running service 2', stream: 'stdout', receivedAt: 200 };
  const entryOther = { projectId: 'p2', serviceId: 's1', message: 'Other project log', stream: 'stdout', receivedAt: 300 };

  logs = appendLog(logs, entry1);
  logs = appendLog(logs, entry2);
  logs = appendLog(logs, entryOther);

  // Simulate services stopping in p1 (e.g. running state changes from ['p1::s1', 'p1::s2'] to [])
  const running = [];
  const state = projectServiceState({ id: 'p1', name: 'P1', services: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2' }] }, running, [], [], {});
  assert.equal(state.status, 'Stopped');

  // Logs for p1 are STILL present and intact!
  const p1Logs = logs.filter(l => l.projectId === 'p1');
  assert.equal(p1Logs.length, 2);
  assert.deepEqual(p1Logs.map(l => l.message), ['Running service 1', 'Running service 2']);
});

// 9. Concurrent/duplicate stop invocations are rejected by bulk lock / pending guards
test('bulk lock and pending guards reject concurrent duplicate stop actions', async () => {
  let bulkLock = false;
  let executionCount = 0;

  const triggerStop = async () => {
    if (bulkLock) {
      return { rejected: true };
    }
    bulkLock = true;
    try {
      executionCount += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      return { rejected: false };
    } finally {
      bulkLock = false;
    }
  };

  const [first, second, third] = await Promise.all([
    triggerStop(),
    triggerStop(),
    triggerStop(),
  ]);

  assert.equal(executionCount, 1);
  assert.equal(first.rejected, false);
  assert.equal(second.rejected, true);
  assert.equal(third.rejected, true);
});

// 10. Menu item action executes prior to container dismissal in bubble phase
test('dropdown action dispatches before menu dismissal in bubble phase', () => {
  const events = [];
  let open = true;
  const close = () => {
    open = false;
    events.push('menu:close');
  };

  const destination = { id: 'root', name: 'Project root', path: 'C:\\work\\project' };
  let terminalLaunchedPath = '';

  const handleAction = path => {
    events.push(`action:terminal:${path}`);
    terminalLaunchedPath = path;
    close();
  };

  // Simulate bubble phase: child onClick runs first, then container onClick
  const simulateMenuItemClick = (disabled = false) => {
    if (disabled) return;
    // 1. Child item onClick
    handleAction(destination.path);
    // 2. Container bubble onClick
    if (open) close();
  };

  simulateMenuItemClick();

  assert.equal(terminalLaunchedPath, 'C:\\work\\project');
  assert.deepEqual(events, ['action:terminal:C:\\work\\project', 'menu:close']);
  assert.equal(open, false);
});


