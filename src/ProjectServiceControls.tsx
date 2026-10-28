import { useOperationError } from './use-operation-error';
import { OperationNotice } from './NotificationCenter';
import { errorMessage } from './operation-error';
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Loader2, Play, Square } from 'lucide-react';
import { Button, ConfirmDialog, FloatingMenu } from './components';
import { logStopServices, type LogStopScope } from './log-utils';
import { serviceKey } from './types';
import type { Project } from './types';
import { stopAllConfirmation, stopScopeConfirmation, type ProjectServiceState } from './project-service-state';

export type ServiceMode = 'start' | 'stop' | 'stop-frontend' | 'stop-backend' | 'stop-both';
type Mode = ServiceMode;
type Snapshot = { states: ProjectServiceState[]; busy: boolean; stopPending?: boolean; activeKeys?: string[]; stoppingKeys?: string[] };
type Controls = Snapshot & { request: (project: Project, mode: Mode) => void };
export const ProjectServicesContext = createContext<Controls | undefined>(undefined);

// Main remains the only owner of lifecycle actions. Floating windows send project IDs,
// never commands or stale service definitions. Opening/closing only subscribes to state.
export function useProjectServicesBridge(snapshot: Snapshot, action: (projectId: string, mode: Mode) => void | Promise<void>) {
  const latest = useRef({ snapshot, action }); latest.current = { snapshot, action };
  const subscribers = useRef(new Set<string>());
  const publish = (label: string) => { void emitTo(label, 'project-services-state', latest.current.snapshot).catch(() => { subscribers.current.delete(label); }); };
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    void (async () => {
      const subscribe = await listen<string>('project-services-subscribe', event => {
        const label = event.payload;
        const valid = label === 'quick-editor' || label.startsWith('logs-');
        if (!disposed && valid) { subscribers.current.add(label); publish(label); }
      });
      if (disposed) { subscribe(); return; } stops.push(subscribe);
      const request = await listen<{ projectId: string; mode: Mode; replyTo: string }>('project-services-action', event => {
        const payload = event.payload;
        const expected = payload && typeof payload.projectId === 'string' ? 'logs-' + Array.from(new TextEncoder().encode(payload.projectId), byte => byte.toString(16).padStart(2, '0')).join('') : '';
        if (!disposed && payload && typeof payload.projectId === 'string' && (payload.replyTo === 'quick-editor' || payload.replyTo === expected) && ['start', 'stop', 'stop-frontend', 'stop-backend', 'stop-both'].includes(payload.mode) && subscribers.current.has(payload.replyTo)) {
          void Promise.resolve().then(() => latest.current.action(payload.projectId, payload.mode))
            .then(() => emitTo(payload.replyTo, 'project-services-result', ''), cause => emitTo(payload.replyTo, 'project-services-result', errorMessage(cause))).catch(console.error);
        }
      });
      if (disposed) request(); else stops.push(request);
    })().catch(console.error);
    return () => { disposed = true; stops.forEach(stop => stop()); subscribers.current.clear(); };
  }, []);
  useEffect(() => {
    subscribers.current.forEach(publish);
  }, [snapshot]);
}

export function RemoteProjectServices({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ states: [], busy: true });
  const [confirmation, setConfirmation] = useState<ReturnType<typeof stopAllConfirmation>>();
  const [error, setError] = useOperationError();
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    void (async () => {
      const state = await listen<Snapshot>('project-services-state', event => { if (!disposed) setSnapshot(event.payload); }, { target: getCurrentWindow().label });
      if (disposed) { state(); return; } stops.push(state);
      const result = await listen<string>('project-services-result', event => {
        if (!disposed) { pendingRef.current = false; setPending(false); if (!event.payload) setError(''); else setError(`Service action failed: ${event.payload}. Check Projects and Logs before retrying.`); }
      }, { target: getCurrentWindow().label });
      if (disposed) { result(); return; } stops.push(result);
      await emitTo('main', 'project-services-subscribe', getCurrentWindow().label);
    })().catch(cause => { if (!disposed) setError(`Service controls could not connect. Reopen this window to retry: ${errorMessage(cause)}`, true); });
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, []);
  const send = (project: Project, mode: Mode) => {
    if (pendingRef.current || (mode === 'start' ? snapshot.busy : snapshot.stopPending)) return;
    pendingRef.current = true; setPending(true); setError('');
    void emitTo('main', 'project-services-action', { projectId: project.id, mode, replyTo: getCurrentWindow().label }).catch(cause => {
      pendingRef.current = false; setPending(false); setError(`Service action was not sent: ${errorMessage(cause)}. Try again.`);
    });
  };
  return <ProjectServicesContext.Provider value={{ ...snapshot, busy: snapshot.busy || pending, stopPending: snapshot.stopPending || pending, request: (project, mode) => {
    if (mode !== 'start') { const scope = mode === 'stop' ? 'all' : mode.slice(5) as LogStopScope; const services = logStopServices(project.services, scope); setConfirmation(stopScopeConfirmation(project, scope, services, () => send(project, mode))); }
    else send(project, mode);
  } }}>{children}<OperationNotice message={error} dismiss={() => setError('')} />{confirmation && <ConfirmDialog {...confirmation} onCancel={() => setConfirmation(undefined)} onConfirm={() => { const action = confirmation.action; setConfirmation(undefined); action(); }} />}</ProjectServicesContext.Provider>;
}

export function ProjectServiceStatus({ project }: { project?: Project }) {
  const source = useContext(ProjectServicesContext);
  const state = source?.states.find(state => state.projectId === project?.id);
  return <span className={`qe-service-status qe-service-status-${state?.status.toLowerCase() || 'unknown'}`} role="status" title={state?.pending ? 'Service action in progress' : 'Service process state; does not indicate port readiness'}><span />{state?.status || 'Connecting…'}</span>;
}

export function ProjectServiceAction({ project }: { project?: Project }) {
  const source = useContext(ProjectServicesContext);
  const state = source?.states.find(state => state.projectId === project?.id);
  const stopping = state?.active;
  return <Button tone={stopping ? 'secondary' : 'primary'} className="qe-service-action" icon={state?.pending ? <Loader2 size={14} className="qe-service-spinner" /> : stopping ? <Square size={14} /> : <Play size={14} />} disabled={!project?.services.length || !state || source?.busy || state.pending} aria-busy={state?.pending} onClick={() => { if (project) source?.request(project, stopping ? 'stop' : 'start'); }}>{state?.pending ? state.status === 'Starting' ? 'Starting…' : 'Stopping…' : stopping ? 'Stop All' : 'Start All'}</Button>;
}

export function ProjectServiceErrors({ project }: { project?: Project }) {
  const source = useContext(ProjectServicesContext);
  const state = source?.states.find(state => state.projectId === project?.id);
  return state?.errors.length ? <div className="qe-service-errors" role="alert">{state.errors.map(error => <p key={error}>{error}</p>)}<p>Open Logs to inspect output. Stop active services before editing commands in Projects, then retry Start All.</p></div> : null;
}

// Shared by main, docked, and floating Logs; all requests still run in main.
export function LogsServiceControls({ project }: { project: Project }) {
  const source = useContext(ProjectServicesContext);
  const state = source?.states.find(item => item.projectId === project.id);
  const active = (service: Project['services'][number]) => source?.activeKeys?.includes(serviceKey(project.id, service.id));
  return <div className="console-stopbar" role="group" aria-label={`Services in ${project.name}`}>
    <ProjectServiceStatus project={project} />
    <Button icon={<Play size={13} />} disabled={!state || source?.busy || state.pending || !project.services.length || project.services.every(active)} onClick={() => source?.request(project, 'start')}>Start all</Button>
    <FloatingMenu label="Stop" icon={<Square size={13} />} align="end">{close => <>
      {(['all', 'frontend', 'backend', 'both'] as const).map(scope => { const services = logStopServices(project.services, scope).filter(active); const stopping = services.length > 0 && services.every(service => source?.stoppingKeys?.includes(serviceKey(project.id, service.id))); return <button key={scope} role="menuitem" disabled={!state || source?.stopPending || !services.length || stopping} title="Only DevFlow-managed services in this project; independent of log filters" onClick={() => { source?.request(project, scope === 'all' ? 'stop' : `stop-${scope}`); close(); }}>Stop {scope}<span>{services.length}</span></button>; })}
    </>}</FloatingMenu>
    <ProjectServiceErrors project={project} />
  </div>;
}
