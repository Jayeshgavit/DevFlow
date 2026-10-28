import { writeLogClipboard, exportLogText } from './log-actions';
import { useOperationError } from './use-operation-error';
import { OperationNotice } from './NotificationCenter';
import { errorMessage } from './operation-error';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ChevronDown, ChevronUp, ExternalLink, PanelBottom, Terminal, X } from 'lucide-react';
import { LogsServiceControls, ProjectServiceStatus } from './ProjectServiceControls';
import { Button, LogViewer } from './components';
import type { LogEntry } from './log-utils';
import type { Project } from './types';
import { serviceKey } from './types';
import { applyLogFrame, createLogFrames, type SharedFrame, type SharedRow } from './log-sharing';
import './shared-logs.css';

type Source = { logs: LogEntry[]; projects: Project[]; active: string[]; stopping: string[]; clear: (entries: LogEntry[]) => void; controls?: (project: Project) => React.ReactNode };
export const LogsContext = createContext<Source | undefined>(undefined);
type Subscription = { token: string; projectId: string; label: string };
type Subscriber = Subscription & { frame: ReturnType<typeof createLogFrames>; rows: Map<number, LogEntry>; sending: boolean; dirty: boolean };
const scopeEntries = (logs: LogEntry[], id: string) => id ? logs.filter(entry => entry.projectId === id || (!!entry.incidentId && !entry.projectId)) : [];

// Only main ingests service-log/service-log-batch. Other webviews consume projections.
export function useLogsBridge(source: Source) {
  const latest = useRef(source); latest.current = source;
  const subscribers = useRef(new Map<string, Subscriber>());
  const publish = (sub: Subscriber, reset: boolean) => {
    // Keep at most one delivery in flight. Coalesce slow consumers to current state.
    if (sub.sending) { sub.dirty = true; return; }
    const current = latest.current;
    const project = current.projects.find(project => project.id === sub.projectId);
    const frame = sub.frame(scopeEntries(current.logs, sub.projectId), reset, project, current.active, current.stopping);
    frame.removed.forEach(id => sub.rows.delete(id));
    if (reset) sub.rows.clear();
    frame.rows.forEach(row => sub.rows.set(row.id, row.entry));
    sub.sending = true;
    void emitTo(sub.label, 'logs-frame', { token: sub.token, frame }).catch(() => { subscribers.current.delete(sub.token); }).finally(() => {
      sub.sending = false;
      if (subscribers.current.get(sub.token) === sub && sub.dirty) { sub.dirty = false; publish(sub, false); }
    });
  };
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const add = async <T,>(name: string, callback: (payload: T) => void) => {
      const stop = await listen<T>(name, event => { if (!disposed) callback(event.payload); });
      if (disposed) stop(); else stops.push(stop);
    };
    void (async () => {
      await add('logs-subscribe', (request: Subscription) => {
          if (!request || typeof request.projectId !== 'string' || typeof request.token !== 'string' || !['quick-editor', logsLabel(request.projectId)].includes(request.label) || !latest.current.projects.some(project => project.id === request.projectId)) return;
          // One projection per native window. A retry replaces its old subscription.
          for (const [token, sub] of subscribers.current) if (sub.label === request.label) subscribers.current.delete(token);
          const sub: Subscriber = { ...request, frame: createLogFrames(), rows: new Map(), sending: false, dirty: false };
          subscribers.current.set(request.token, sub); publish(sub, true);
      });
      await add('logs-unsubscribe', (token: string) => { subscribers.current.delete(token); });
      await add('logs-window-closed', (label: string) => { for (const [token, sub] of subscribers.current) if (sub.label === label) subscribers.current.delete(token); });
      await add('logs-clear', (request: { token: string; ids: number[] }) => {
          const sub = subscribers.current.get(request.token);
          if (sub) latest.current.clear(request.ids.map(id => sub.rows.get(id)).filter((entry): entry is LogEntry => !!entry));
      });
    })().catch(console.error);
    return () => { disposed = true; stops.forEach(stop => stop()); subscribers.current.clear(); };
  }, []);
  useEffect(() => { subscribers.current.forEach(sub => publish(sub, false)); }, [source.logs, source.projects, source.active, source.stopping]);
}

export const logsLabel = (id: string) => 'logs-' + Array.from(new TextEncoder().encode(id), byte => byte.toString(16).padStart(2, '0')).join('');
export const floatLogs = (project: Project) => invoke('logs_float', { projectId: project.id });
export const floatingLogsProject = new URLSearchParams(window.location.search).get('window') === 'logs' ? new URLSearchParams(window.location.search).get('project') : null;

function useRemoteLogs(projectId: string | undefined) {
  const [source, setSource] = useState<Source>();
  const [error, setError] = useOperationError(true);
  const [actionError, setActionError] = useOperationError();
  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let rows: SharedRow[] = [], revision = 0;
    const token = crypto.randomUUID();
    const label = getCurrentWindow().label;
    const subscribe = () => emitTo('main', 'logs-subscribe', { token, projectId, label });
    setSource(undefined); setError(''); setActionError('');
    void (async () => {
      stop = await listen<{ token: string; frame: SharedFrame }>('logs-frame', event => {
        if (disposed || event.payload.token !== token) return;
        const frame = event.payload.frame;
        const next = applyLogFrame(rows, revision, frame);
        if (!next) { revision = 0; void subscribe().catch(cause => { if (!disposed) setError(`Could not reconnect to logs. Reopen this view to retry: ${errorMessage(cause)}`); }); return; }
        rows = next; revision = frame.revision; setError('');
        setSource({ logs: rows.map(row => row.entry), projects: frame.project ? [frame.project] : [], active: frame.active, stopping: frame.stopping,
          clear: entries => { const selected = new Set(entries); void emitTo('main', 'logs-clear', { token, ids: rows.filter(row => selected.has(row.entry)).map(row => row.id) }).then(() => { if (!disposed) setActionError(''); }).catch(cause => { if (!disposed) setActionError(`Could not request clearing logs: ${errorMessage(cause)}`); }); } });
      }, { target: label });
      if (disposed) { stop(); return; }
      await subscribe();
    })().catch(cause => { if (!disposed) setError(`Could not connect to logs. Reopen this view to retry: ${errorMessage(cause)}`); });
    return () => { disposed = true; stop?.(); void emitTo('main', 'logs-unsubscribe', token).catch(() => {}); };
  }, [projectId]);
  return { source, error: actionError || error, dismiss: () => { setError(''); setActionError(''); } };
}

export function ProjectLogs({ project, onAttachLogs, onCheckedLogsChange }: { project: Project; onAttachLogs?: (entries: LogEntry[], label: string) => void; onCheckedLogsChange?: (entries: LogEntry[]) => void }) {
  const local = useContext(LogsContext);
  const remote = useRemoteLogs(local ? undefined : project.id);
  const source = local || remote.source;
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState(''), [follow, setFollow] = useState(true), [message, setMessage] = useState('');
  const [error, setError] = useOperationError();
  useEffect(() => { setFilter('all'); setSearch(''); setError(''); setMessage(''); }, [project.id]);
  const searchRef = useRef<HTMLInputElement>(null);
  const currentProject = source?.projects.find(item => item.id === project.id);
  const logs = useMemo(() => scopeEntries(source?.logs || [], project.id), [source?.logs, project.id]);
  
  if (!source) return <><OperationNotice message={remote.error} dismiss={remote.dismiss} /><p role="status">Connecting to existing service logs…</p></>;
  if (!currentProject) return <p role="status">This project was removed. Services and other projects are unchanged.</p>;
  return <div className="shared-console" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); searchRef.current?.focus(); } }}>
    <OperationNotice message={remote.error || error} dismiss={() => { remote.dismiss(); setError(''); }} /><div className="shared-service-status" role="status">{currentProject.services.map(service => { const key = serviceKey(project.id, service.id); return <span key={key}>{service.name}: {source.stopping.includes(key) ? 'Stopping' : source.active.includes(key) ? 'Active' : 'Stopped'}</span>; })}</div>
    <LogViewer project={currentProject} logs={logs} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} searchRef={searchRef} autoScroll={follow} setAutoScroll={setFollow} actionMessage={message} onAttachLogs={onAttachLogs} onCheckedLogsChange={onCheckedLogsChange} serviceControls={source.controls?.(currentProject) || <LogsServiceControls project={currentProject} />}
      onCopy={async (text, notice) => { try { await writeLogClipboard(text); setError(''); setMessage(notice); return true; } catch (cause) { setMessage(''); setError(`Could not copy logs: ${errorMessage(cause)}`); return false; } }}
      onExport={async text => { try { const saved = await exportLogText(currentProject, text); setMessage(saved ? 'Logs exported' : 'Export cancelled'); return saved; } catch (cause) { setMessage(''); setError(`Could not export logs: ${errorMessage(cause)}`); return false; } }}
      onClear={entries => source.clear(entries)} onOpenUrl={url => { void invoke('open_local_url', { url }).then(() => setError('')).catch(cause => setError(`Could not open local URL: ${errorMessage(cause)}`)); }} />
  </div>;
}

export function LogsHeader({ project, onFloat, onDock, collapsed, onCollapse, onHide, busy }: { project?: Project; onFloat?: () => void; onDock?: () => void; collapsed?: boolean; onCollapse?: () => void; onHide?: () => void; busy?: boolean }) {
  return <header className="shared-logs-heading"><div className="shared-logs-context"><strong><Terminal size={15} />Logs</strong><span className="shared-logs-project">{project?.name || 'DevFlow'}</span>{project && <ProjectServiceStatus project={project} />}</div><div className="shared-logs-actions">
    {onFloat && <Button tone="quiet" icon={<ExternalLink size={14} />} title="Open project logs in their own window" onClick={onFloat}>Float</Button>}
    {onDock && <Button tone="secondary" icon={<PanelBottom size={14} />} title="Dock logs in Quick Editor" disabled={!project || busy} onClick={onDock}>{busy ? 'Docking…' : 'Dock in Quick Editor'}</Button>}
    {onCollapse && <Button tone="quiet" aria-label={collapsed ? 'Expand logs' : 'Collapse logs'} title={collapsed ? 'Expand logs' : 'Collapse logs'} aria-expanded={!collapsed} onClick={onCollapse}>{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</Button>}
    {onHide && <Button tone="quiet" aria-label="Hide logs" title="Hide logs" onClick={onHide}><X size={14} /></Button>}
  </div></header>;
}

export function FloatingLogs() {
  const [project, setProject] = useState<Project>(), [error, setError] = useOperationError(), [docking, setDocking] = useState(false);
  useEffect(() => {
    const find = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); document.querySelector<HTMLInputElement>('.console-search input')?.focus(); }
    };
    window.addEventListener('keydown', find);
    return () => window.removeEventListener('keydown', find);
  }, []);
  useEffect(() => {
    let disposed = false;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { let theme = 'system'; try { theme = localStorage.getItem('devflow-theme') || theme; } catch {} document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply); window.addEventListener('storage', apply);
    void invoke<Project>('logs_project').then(project => { if (!disposed) setProject(project); }).catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; media.removeEventListener('change', apply); window.removeEventListener('storage', apply); };
  }, []);
  return <main className="floating-logs"><LogsHeader project={project} busy={docking} onDock={() => { setError(''); setDocking(true); void invoke('logs_dock').then(() => setError('')).catch(cause => { setDocking(false); setError(errorMessage(cause)); }); }} /><OperationNotice message={error} dismiss={() => setError('')} />{docking && <p role="status">Dock requested. If Quick Editor has another project open, select this project there. Unsaved files remain protected.</p>}{project && <ProjectLogs project={project} />}</main>;
}
