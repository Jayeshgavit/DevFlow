import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = async file => ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const logUrl = url(await compile('../src/log-utils.ts'));
const { groupLogs } = await import(logUrl);
const source = (await compile('../src/notifications.ts')).replace("'./log-utils'", JSON.stringify(logUrl));
const { NotificationStore, incidentLog, incidentDestination, HISTORY_LIMIT } = await import(url(source));
const exit = (stopRequested = false, exitCode = 1) => ({ projectId: 'p', serviceId: 's', stopRequested, exitCode, status: 'exit' });
function fixture(desktop) {
  let time = 1800000000000;
  const data = new Map();
  const storage = { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
  const store = new NotificationStore(storage, () => time, desktop);
  const toasts = [], logs = [];
  store.onToast = item => toasts.push(item);
  store.onSystemEvent = item => logs.push(item);
  return { store, storage, toasts, logs, advance: (ms = 10000) => time += ms, now: () => time, history: () => store.getSnapshot().history };
}

test('manual stop stays quiet; nonzero exit alerts; zero exit makes no crash claim', () => {
  const f = fixture();
  f.store.stopped('p', 's'); f.store.exit(exit(true));
  assert.equal(f.toasts.length, 0);
  assert.equal(f.history().length, 1);
  assert.equal(f.history()[0].read, true);
  f.store.exit(exit());
  assert.equal(f.toasts.length, 1);
  assert.equal(f.history()[0].reason, 'exit');
  assert.equal(f.history()[0].severity, 'error');
  f.store.exit({ ...exit(false, 0), serviceId: 'other' });
  assert.equal(f.history()[0].severity, 'warning');
  assert.doesNotMatch(f.history()[0].message, /crash/i);
  f.store.flush();
});

test('failed starts and restart loops group by service and rate limit alerts', () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    f.store.record({ reason: 'start-failed', projectId: 'p', serviceId: 's', message: 'Restart failed: executable missing' });
    f.advance(1000);
  }
  assert.equal(f.history().length, 1);
  assert.equal(f.history()[0].occurrences, 20);
  assert.equal(f.toasts.length, 1);
  assert.equal(f.logs.length, 1);
  f.store.flush();
});

test('health requires sustained distinct samples, recovers once, correlates subsequent exit', () => {
  const f = fixture();
  const sample = (status = 'unhealthy') => f.store.sample('p', 's', { status, checkedAt: f.now() });
  sample(); sample();
  assert.equal(f.history().length, 0);
  f.advance(); sample();
  assert.equal(f.history().length, 0);
  f.advance(); sample();
  const id = f.history()[0].id;
  assert.equal(f.history()[0].reason, 'health');
  f.store.exit(exit());
  assert.equal(f.history().length, 1);
  assert.equal(f.history()[0].id, id);
  // Late probes from the exited process must not claim recovery.
  f.advance(); sample('healthy');
  assert.equal(f.history().length, 1);
  f.store.started('p', 's');
  f.advance(); sample('healthy');
  assert.equal(f.history()[0].reason, 'recovery');
  assert.equal(f.history().find(item => item.id === id).resolved, true);
  assert.equal(f.toasts.length, 2);
  f.advance(); sample('healthy');
  assert.equal(f.history().length, 3);
  f.store.flush();
});

test('unknown/disabled probes and missing output do not produce incidents', () => {
  const f = fixture();
  for (const status of ['checking', 'unknown', 'disabled', 'notApplicable']) {
    f.store.sample('p', 's', { status, checkedAt: f.now() }); f.advance();
  }
  assert.equal(f.history().length, 0);
});

test('port diagnostic and exit share an ID without fabricating the cause', () => {
  const f = fixture();
  f.store.diagnostic({ projectId: 'p', serviceId: 's', kind: 'port-conflict' });
  const id = f.history()[0].id;
  f.store.exit(exit());
  assert.equal(f.history().length, 1);
  assert.equal(f.history()[0].id, id);
  assert.match(f.history()[0].message, /output reports/);
  assert.match(f.history()[0].message, /subsequently exited/);
  assert.equal(f.toasts.length, 1);
  f.store.flush();
});

test('history, read state, preferences and system log references survive reload', () => {
  const f = fixture();
  f.store.record({ reason: 'save-failed', message: 'password=secret-value could not save' });
  const incident = f.history()[0];
  assert.doesNotMatch(incident.message, /secret-value/);
  const log = incidentLog(incident);
  assert.equal(log.stream, 'system');
  assert.equal(log.incidentId, incident.logRef);
  assert.match(log.message, /DevFlow/);
  f.store.markRead(incident.id); f.store.preferences({ quiet: true }); f.store.flush();
  const loaded = new NotificationStore(f.storage, f.now);
  assert.equal(loaded.getSnapshot().history[0].id, incident.id);
  assert.equal(loaded.getSnapshot().history[0].read, true);
  assert.equal(loaded.getSnapshot().preferences.quiet, true);
  loaded.clearRead(); assert.equal(loaded.getSnapshot().history.length, 0); loaded.flush();
});

test('history is bounded and old incidents expire', () => {
  const f = fixture();
  for (let index = 0; index < HISTORY_LIMIT + 10; index++) f.store.record({ reason: 'application', serviceId: String(index), message: 'Action failed' });
  assert.equal(f.history().length, HISTORY_LIMIT);
  assert.equal(f.toasts.length, 3);
  f.advance(31 * 86400000); f.store.flush();
  const reloaded = new NotificationStore(f.storage, f.now);
  assert.equal(reloaded.getSnapshot().history.length, 0);
});

test('desktop failure preserves incidents and suspends retries until preference changes', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('Windows unavailable'); });
  f.store.preferences({ desktop: true }); f.store.exit(exit());
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.match(f.store.getSnapshot().desktopError, /unavailable/);
  f.advance(31000); f.store.exit(exit()); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(f.history()[0].occurrences, 2);
  f.store.preferences({ desktop: true }); f.advance(31000); f.store.exit(exit()); await Promise.resolve();
  assert.equal(calls, 2); f.store.flush();
});

test('quiet mode suppresses interruptions, not records; routine preference controls unread', () => {
  const f = fixture();
  f.store.preferences({ quiet: true, routine: true });
  f.store.started('p', 's'); f.store.exit(exit());
  assert.equal(f.history().length, 2);
  assert.ok(f.history().every(item => !item.read));
  assert.equal(f.toasts.length, 0); f.store.flush();
});

test('storage errors and malformed data degrade safely', () => {
  const broken = { getItem: () => '{', setItem: () => { throw new Error('quota'); } };
  const store = new NotificationStore(broken);
  assert.match(store.getSnapshot().storageError, /loaded/);
  store.record({ reason: 'application', message: 'Operation failed' }); store.flush();
  assert.match(store.getSnapshot().storageError, /saved/);
  assert.equal(store.getSnapshot().history.length, 1);
});

test('log navigation chooses exact project/service and detects removed configuration', () => {
  const f = fixture(); f.store.exit(exit());
  const incident = f.history()[0];
  const projects = [{ id: 'other', services: [{ id: 's' }] }, { id: 'p', services: [{ id: 's' }] }];
  assert.equal(incidentDestination(incident, projects).project.id, 'p');
  assert.equal(incidentDestination(incident, projects).filter, 's');
  assert.equal(incidentDestination(incident, projects.slice(0, 1)).missing, true);
  assert.equal(incidentDestination(incident, [{ id: 'p', services: [] }]).filter, 'all');
  assert.equal(incidentLog(incident).incidentId, incident.id);
  f.store.flush();
});

test('recovery preference suppresses recovery toast while retaining event', () => {
  const f = fixture(); f.store.preferences({ recovery: false });
  f.store.exit(exit()); f.store.started('p', 's'); f.advance(31000);
  f.store.sample('p', 's', { status: 'healthy', checkedAt: f.now() });
  assert.equal(f.history()[0].reason, 'recovery');
  assert.equal(f.toasts.length, 1); f.store.flush();
});

test('unrelated application failures are retained separately; stale probes do not count', () => {
  const f = fixture();
  f.store.record({ reason: 'application', message: 'Could not subscribe to events' });
  f.store.record({ reason: 'application', message: 'Could not refresh service status' });
  assert.equal(f.history().length, 2);
  const first = f.now();
  f.store.sample('p', 's', { status: 'unhealthy', checkedAt: first });
  f.advance(20000);
  f.store.sample('p', 's', { status: 'unhealthy', checkedAt: first - 1 });
  f.store.sample('p', 's', { status: 'unhealthy', checkedAt: f.now() });
  assert.equal(f.history().length, 2);
  f.advance(); f.store.sample('p', 's', { status: 'unhealthy', checkedAt: f.now() });
  assert.equal(f.history()[0].reason, 'health');
  f.store.stopped('p', 's');
  f.advance(); f.store.sample('p', 's', { status: 'healthy', checkedAt: f.now() });
  assert.equal(f.history()[0].reason, 'stopped');
  f.store.flush();
});

test('system events preserve explicit warning severity independently of error words', () => {
  const f = fixture();
  const incident = f.store.record({ reason: 'health', severity: 'warning', projectId: 'p', serviceId: 's', message: 'Health checks failed repeatedly' });
  const groups = groupLogs([incidentLog(incident)]);
  assert.equal(groups[0].category, 'warning');
  assert.equal(groups[0].http, null);
  f.store.flush();
});

test('notification details redact database URLs, JSON secrets and session headers', () => {
  const f = fixture();
  for (const message of ['postgres://user:database-password@localhost/db', '{"API_KEY": "json-secret"}', 'Cookie: session=session-secret', 'Authorization: Basic encoded-secret']) {
    const incident = f.store.record({ reason: 'application', message });
    assert.doesNotMatch(incident.message, /database-password|json-secret|session-secret|encoded-secret/);
  }
  f.store.flush();
});
