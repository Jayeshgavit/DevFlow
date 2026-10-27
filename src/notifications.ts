import { redactForSharing } from './log-utils';
import type { HealthSnapshot, ServiceExit } from './types';
import type { Project } from './types';
import type { LogEntry } from './log-utils';

export type IncidentReason = 'exit' | 'start-failed' | 'stop-failed' | 'health' | 'recovery' | 'port-conflict' | 'log-collection' | 'save-failed' | 'application' | 'started' | 'stopped';
export type IncidentSeverity = 'info' | 'success' | 'warning' | 'error';
export type Incident = { id: string; severity: IncidentSeverity; reason: IncidentReason; message: string; projectId?: string; serviceId?: string; createdAt: number; updatedAt: number; occurrences: number; read: boolean; resolved: boolean; logRef?: string };
export type NotificationPreferences = { desktop: boolean; recovery: boolean; routine: boolean; quiet: boolean };
export type Diagnostic = { projectId: string; serviceId: string; kind: 'port-conflict' | 'log-collection' };
type Input = Pick<Incident, 'reason' | 'message'> & Partial<Pick<Incident, 'projectId' | 'serviceId' | 'severity'>>;
type Snapshot = { history: Incident[]; preferences: NotificationPreferences; storageError: string; desktopError: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
const KEY = 'devflow-notifications-v1';
export const HISTORY_LIMIT = 300;
const MAX_AGE = 30 * 86400000;
const defaults: NotificationPreferences = { desktop: false, recovery: true, routine: false, quiet: false };
const reasons: IncidentReason[] = ['exit', 'start-failed', 'stop-failed', 'health', 'recovery', 'port-conflict', 'log-collection', 'save-failed', 'application', 'started', 'stopped'];
const failureReasons: IncidentReason[] = ['exit', 'start-failed', 'health', 'port-conflict'];
const keyOf = (projectId?: string, serviceId?: string) => JSON.stringify([projectId || '', serviceId || '']);
const safe = (text: string) => redactForSharing(text)
  .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
  .replace(/("(?:[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)|authorization|cookie|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[redacted]"')
  .replace(/(\b(?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[redacted]')
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 600);

export function incidentLog(incident: Incident): LogEntry {
  return { projectId: incident.projectId || '', serviceId: incident.serviceId || '', stream: 'system', receivedAt: incident.updatedAt, incidentId: incident.id, systemSeverity: incident.severity,
    message: `[DevFlow · ${incident.severity}] ${incident.message}${incident.occurrences > 1 ? ` (${incident.occurrences} occurrences)` : ''}` };
}

export function incidentDestination(incident: Incident, projects: Project[]) {
  const project = projects.find(project => project.id === incident.projectId);
  return { project, missing: Boolean(incident.projectId && !project), filter: project?.services.some(service => service.id === incident.serviceId) ? incident.serviceId! : 'all' };
}

/** Single writer for incidents. No raw log subscription or process inference. */
export class NotificationStore {
  private snapshot: Snapshot = { history: [], preferences: { ...defaults }, storageError: '', desktopError: '' };
  private listeners = new Set<() => void>();
  private health = new Map<string, { failures: number; since: number; sample?: number; degraded: boolean }>();
  private inactive = new Set<string>();
  private alerts: number[] = [];
  private alerted = new Map<string, number>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private desktopFailed = false;
  onSystemEvent?: (entry: LogEntry) => void;
  onToast?: (incident: Incident) => void;
  constructor(private storage?: Storage, private now = Date.now, private desktop?: (incident: Incident) => Promise<void>) {
    try {
      const raw = storage?.getItem(KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.history)) throw new Error('Invalid history');
      const history: Incident[] = data.history.filter((item: Incident) => item && typeof item.id === 'string' && typeof item.message === 'string' && reasons.includes(item.reason)
        && ['info', 'success', 'warning', 'error'].includes(item.severity) && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt)
        && item.updatedAt <= this.now() && item.updatedAt > this.now() - MAX_AGE && Number.isSafeInteger(item.occurrences) && item.occurrences > 0
        && (item.projectId === undefined || typeof item.projectId === 'string') && (item.serviceId === undefined || typeof item.serviceId === 'string'))
        .slice(0, HISTORY_LIMIT).map((item: Incident) => ({ id: item.id.slice(0, 100), message: safe(item.message), severity: item.severity, reason: item.reason,
          projectId: item.projectId, serviceId: item.serviceId, createdAt: item.createdAt, updatedAt: item.updatedAt, occurrences: item.occurrences, read: item.read === true, resolved: item.resolved === true, logRef: item.id.slice(0, 100) }));
      const preferences = { ...defaults };
      for (const key of Object.keys(defaults) as (keyof NotificationPreferences)[]) if (typeof data.preferences?.[key] === 'boolean') preferences[key] = data.preferences[key];
      this.snapshot = { ...this.snapshot, history, preferences };
    } catch { this.snapshot.storageError = 'Notification history could not be loaded. New events remain available in this session.'; }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() {
    this.listeners.forEach(listener => listener());
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 400);
  }
  flush = () => {
    clearTimeout(this.saveTimer);
    try {
      if (!this.storage) throw new Error('Storage unavailable');
      this.storage.setItem(KEY, JSON.stringify({ version: 1, history: this.snapshot.history, preferences: this.snapshot.preferences }));
      if (this.snapshot.storageError) { this.snapshot = { ...this.snapshot, storageError: '' }; this.listeners.forEach(listener => listener()); }
    } catch {
      this.snapshot = { ...this.snapshot, storageError: 'Notification history could not be saved. Events remain available in this session.' };
      this.listeners.forEach(listener => listener());
    }
  };
  preferences = (changes: Partial<NotificationPreferences>) => {
    this.snapshot = { ...this.snapshot, preferences: { ...this.snapshot.preferences, ...changes } };
    if (changes.desktop !== undefined) { this.desktopFailed = false; this.snapshot.desktopError = ''; }
    this.publish();
  };
  markRead = (id?: string) => { this.snapshot = { ...this.snapshot, history: this.snapshot.history.map(item => !id || item.id === id ? { ...item, read: true } : item) }; this.publish(); };
  clearRead = () => { this.snapshot = { ...this.snapshot, history: this.snapshot.history.filter(item => !item.read) }; this.publish(); };
  record(input: Input): Incident {
    const now = this.now();
    const routine = input.reason === 'started' || input.reason === 'stopped';
    const scope = keyOf(input.projectId, input.serviceId);
    const message = safe(input.message);
    const group = failureReasons.includes(input.reason) ? 'service-failure' : input.reason;
    const previous = this.snapshot.history.find(item => keyOf(item.projectId, item.serviceId) === scope && !item.resolved
      && (failureReasons.includes(item.reason) ? 'service-failure' : item.reason) === group
      && (group === 'service-failure' || item.message === message) && now - item.updatedAt < 5 * 60000);
    // Preserve a supported diagnostic when the correlated exit arrives; never invent a cause.
    const keepDiagnostic = previous?.reason === 'port-conflict' && input.reason === 'exit';
    const incident: Incident = { id: previous?.id || crypto.randomUUID(), createdAt: previous?.createdAt || now, updatedAt: now,
      occurrences: Math.min(Number.MAX_SAFE_INTEGER, (previous?.occurrences || 0) + 1), read: routine ? !this.snapshot.preferences.routine : false, resolved: routine || input.reason === 'recovery',
      ...input, message: safe(keepDiagnostic ? `${previous.message.replace(/ Process subsequently exited\.$/, '')} Process subsequently exited.` : input.message),
      reason: keepDiagnostic ? 'port-conflict' : input.reason, severity: input.severity || (routine ? 'info' : input.reason === 'recovery' ? 'success' : 'error') };
    incident.logRef = incident.id;
    this.snapshot = { ...this.snapshot, history: [incident, ...this.snapshot.history.filter(item => item.id !== incident.id && now - item.updatedAt < MAX_AGE)].slice(0, HISTORY_LIMIT) };
    this.publish();
    // Repeated identical failures update the center, without flooding the log buffer.
    if (!previous || previous.reason !== incident.reason || previous.message !== incident.message) this.onSystemEvent?.(incidentLog(incident));
    const prefs = this.snapshot.preferences;
    const eligible = !routine && (input.reason !== 'recovery' || prefs.recovery);
    this.alerts = this.alerts.filter(time => now - time < 60000);
    for (const [id, time] of this.alerted) if (now - time > 5 * 60000) this.alerted.delete(id);
    const alertKey = `${scope}:${input.reason === 'recovery' ? 'recovery' : 'failure'}`;
    if (eligible && !prefs.quiet && this.alerts.length < 3 && now - (this.alerted.get(alertKey) ?? -Infinity) >= 30000) {
      this.alerts.push(now); this.alerted.set(alertKey, now);
      this.onToast?.(incident);
      if (prefs.desktop && incident.severity !== 'success' && !this.desktopFailed && this.desktop) {
        void this.desktop(incident).catch(() => {
          this.desktopFailed = true;
          this.snapshot = { ...this.snapshot, desktopError: 'Windows alerts are unavailable. Check Windows notification settings, then toggle Desktop alerts to retry. In-app events are still recorded.' };
          this.listeners.forEach(listener => listener());
        });
      }
    }
    return incident;
  }
  started(projectId: string, serviceId: string) {
    this.inactive.delete(keyOf(projectId, serviceId));
    this.health.delete(keyOf(projectId, serviceId));
    this.record({ reason: 'started', projectId, serviceId, message: 'Service process started. Endpoint readiness is checked separately.' });
  }
  stopped(projectId: string, serviceId: string) {
    this.inactive.add(keyOf(projectId, serviceId));
    this.health.delete(keyOf(projectId, serviceId));
    this.resolve(projectId, serviceId);
    this.record({ reason: 'stopped', projectId, serviceId, message: 'Service stopped by request.' });
  }
  exit(event: ServiceExit) {
    this.health.delete(keyOf(event.projectId, event.serviceId));
    if (event.stopRequested) return;
    this.inactive.add(keyOf(event.projectId, event.serviceId));
    this.record({ reason: 'exit', projectId: event.projectId, serviceId: event.serviceId,
      message: event.exitCode === 0 ? 'Service exited without a stop request (code 0).' : `Service exited unexpectedly (code ${event.exitCode ?? 'unavailable'}). Review its output.`, severity: event.exitCode === 0 ? 'warning' : 'error' });
  }
  diagnostic(event: Diagnostic) { this.record({ reason: event.kind, projectId: event.projectId, serviceId: event.serviceId,
    message: event.kind === 'port-conflict' ? 'Service output reports an address already in use. Review the port configuration and output.' : 'DevFlow could not collect a service output stream. Some logs may be missing.' }); }
  private resolve(projectId: string, serviceId: string) {
    this.snapshot = { ...this.snapshot, history: this.snapshot.history.map(item => item.projectId === projectId && item.serviceId === serviceId && failureReasons.includes(item.reason) ? { ...item, resolved: true } : item) };
  }
  sample(projectId: string, serviceId: string, snapshot: HealthSnapshot) {
    const key = keyOf(projectId, serviceId);
    if (this.inactive.has(key)) return;
    if (snapshot.status !== 'healthy' && snapshot.status !== 'unhealthy') { this.health.delete(key); return; }
    const state = this.health.get(key) || { failures: 0, since: this.now(), degraded: false };
    // React rerenders and repeated Check Now results must not count as new probes.
    if (!snapshot.checkedAt || (state.sample !== undefined && snapshot.checkedAt <= state.sample)) return;
    state.sample = snapshot.checkedAt;
    if (snapshot.status === 'unhealthy') {
      if (!state.failures) state.since = this.now();
      state.failures += 1;
      if (!state.degraded && state.failures >= 3 && this.now() - state.since >= 15000) {
        state.degraded = true;
        this.record({ reason: 'health', severity: 'warning', projectId, serviceId, message: 'Health checks failed repeatedly for at least 15 seconds. The process may still be running; review the endpoint and logs.' });
      }
    } else {
      const priorFailure = this.snapshot.history.some(item => item.projectId === projectId && item.serviceId === serviceId && failureReasons.includes(item.reason) && !item.resolved);
      if (state.degraded || priorFailure) {
        this.resolve(projectId, serviceId);
        this.record({ reason: 'recovery', projectId, serviceId, message: 'The configured health endpoint is responding successfully again.' });
      }
      state.degraded = false; state.failures = 0;
    }
    this.health.set(key, state);
  }
}

export function notificationStorage(): Storage | undefined { try { return localStorage; } catch { return undefined; } }
