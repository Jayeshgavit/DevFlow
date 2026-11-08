import KeyboardSettings from './KeyboardSettings';
import { useShortcuts } from './shortcuts';
import { HelpHost, HelpLink } from './UserGuide';
import ChatStorageSettings from './ChatStorageSettings';
import EditorPreferences from './EditorPreferences';
import Overview, { type EnvironmentSummary } from './Overview';
import { writeLogClipboard, exportLogText } from './log-actions';
import { useOperationError } from './use-operation-error';
import { OperationNotice } from './NotificationCenter';
import { errorMessage } from './operation-error';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowRight, FolderPlus, Pencil, Play, RefreshCw, Save, Settings2, Square, Terminal, Trash2, X } from 'lucide-react';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import { AddServiceDialog, Button, Card, ConfirmDialog, EmptyState, LogViewer, ProjectShortcuts, QuickSearchDialog, RenameProjectDialog, ServiceRow, Sidebar, Status } from './components';
import type { HealthSnapshot, LogLine, Project, RunOption, Service, ServiceExit, ServiceLogBatch, ServiceHealthConfig, Theme, View } from './types';
import type { LogEntry } from './log-utils';
import { appendLog, appendLogs, createAnsiLogNormalizer, createSourceDeduper, groupLogs, logStopServices, type LogStopScope } from './log-utils';
import { serviceKey } from './types';
import { ProjectStore, type ProjectSnapshot } from './project-store';
import { runBulkAction, type BulkMode, type BulkResult } from './bulk-actions';
import { SystemCenter } from './SystemCenter';
import { NotificationStore, incidentLog, incidentDestination, notificationStorage, type Diagnostic, type Incident } from './notifications';
import { NotificationCenter, NotificationSettings } from './NotificationCenter';
import './style.css';
import './log-console.css';

import { EditorWorkspace, FloatingEditor, floatingEditor, WindowCloseHandler } from './EditorWorkspace';
import { LogsServiceControls, ProjectServicesContext, RemoteProjectServices, useProjectServicesBridge } from './ProjectServiceControls';
import { projectServiceState, stopAllConfirmation, stopScopeConfirmation } from './project-service-state';
import { LogsContext, useLogsBridge, floatLogs, FloatingLogs, floatingLogsProject } from './SharedLogs';

const ApiTester = React.lazy(() => import('./ApiTester'));
const DeveloperEnvironment = React.lazy(() => import('./DeveloperEnvironment'));
const PortManager = React.lazy(() => import('./PortManager'));

const storedTheme = (): Theme => { try { const value = localStorage.getItem('devflow-theme'); return value === 'dark' || value === 'light' || value === 'system' ? value : 'system'; } catch { return 'system'; } };
const storedCompact = () => { try { return localStorage.getItem('devflow-compact') === 'true'; } catch { return false; } };
const normalizedServicePath = (path: string) => path.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const isConfiguredService = (candidate: Service, services: Service[]) => services.some(service => service.id.toLowerCase() === candidate.id.toLowerCase() || normalizedServicePath(service.cwd) === normalizedServicePath(candidate.cwd));
const commandFlag = (args: string[], flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const isUvicornCommand = (service: Service) => service.args.includes('uvicorn') && service.args.includes('-m');
const setCommandFlag = (args: string[], flag: string, value: string) => { const next = [...args]; const index = next.indexOf(flag); if (index >= 0) { next[index + 1] = value; return next; } next.push(flag, value); return next; };
const defaultHealthConfig = (service: Service): ServiceHealthConfig => ({ enabled: false, host: service.host || '127.0.0.1', port: service.port ?? (Number(commandFlag(service.args, '--port')) || undefined), path: '/', intervalSeconds: 10, timeoutSeconds: 2, expectedStatusMin: 200, expectedStatusMax: 399 });

function App() {
  const [notifications] = useState(() => new NotificationStore(notificationStorage(), Date.now,
    incident => invoke('show_desktop_notification', { incidentId: incident.id })));
  const [logFocus, setLogFocus] = useState<{ incidentId: string; request: number }>();
  const ansiLogNormalizerRef = useRef<ReturnType<typeof createAnsiLogNormalizer> | null>(null);
  if (!ansiLogNormalizerRef.current) ansiLogNormalizerRef.current = createAnsiLogNormalizer();
  const normalizeAnsiLog = ansiLogNormalizerRef.current;
  const [acceptSource] = useState(createSourceDeduper);
  const activeRuns = useRef(new Map<string, string>());
  const latestExits = useRef(new Map<string, ServiceExit>());
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectSnapshot>({ status: 'loading', projects: [], dirty: false, loadError: '' });
  const projectStoreRef = useRef<ProjectStore | null>(null);
  if (!projectStoreRef.current) projectStoreRef.current = new ProjectStore(
    async () => { try { return await invoke<Project[]>('load_projects'); } catch (cause) { notifications.record({ reason: 'application', message: `Saved projects could not be loaded: ${errorMessage(cause)}` }); throw cause; } },
    async projects => { try { await invoke('save_projects', { projects }); } catch (cause) { notifications.record({ reason: 'save-failed', message: `Project configuration could not be saved: ${errorMessage(cause)}` }); throw cause; } },
    setProjectSnapshot,
  );
  const projectStore = projectStoreRef.current;
  const projects = projectSnapshot.projects;
  const dirty = projectSnapshot.dirty;
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<View>('overview');
  const [apiTarget, setApiTarget] = useState<{ projectId: string; url: string }>();
  useEffect(() => { if (view !== 'api' || (apiTarget && apiTarget.projectId !== selected)) setApiTarget(undefined); }, [view, selected, apiTarget]);
  const [editorOpened, setEditorOpened] = useState(false);
  const [environmentSummary, setEnvironmentSummary] = useState<EnvironmentSummary>();
  useEffect(() => {
    let disposed = false; let stop: (() => void) | undefined;
    void listen('logs-open-location', () => { if (!disposed) setView('editor'); }, { target: 'main' }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(cause => setError(errorMessage(cause)));
    return () => { disposed = true; stop?.(); };
  }, []);
  useEffect(() => { if (view === 'editor') setEditorOpened(true); }, [view]);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const logSearchRef = useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState<string[]>([]);
  const [backendStopping, setBackendStopping] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>(() => notifications.getSnapshot().history.map(incidentLog).reverse());
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useOperationError();
  const [serviceErrors, setServiceErrors] = useState<Record<string, string>>({});
  const [serviceExits, setServiceExits] = useState<Record<string, ServiceExit>>({});
  const [busy, setBusy] = useState(false);
  const bulkLock = useRef(false);
  const removeLock = useRef(false);
  const startingKeys = useRef(new Set<string>());
  const stoppingKeys = useRef(new Set<string>());
  const restartingKeys = useRef(new Set<string>());
  const cancelledStarts = useRef(new Set<string>());
  const cancelledBulkStarts = useRef(new Set<string>());
  const logStopLock = useRef(false);
  const [logStopPending, setLogStopPending] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [bulkProgress, setBulkProgress] = useState<Record<string, BulkResult>>({});
  const [bulkSummary, setBulkSummary] = useState<{ projectId: string; text: string; failed: boolean } | null>(null);
  const [actionMessage, setActionMessage] = useState('');
  const clearSharedLogs = (entries: LogEntry[]) => { const removed = new Set(entries); setLogs(current => current.filter(entry => !removed.has(entry))); };
  const logActiveKeys = useMemo(() => [...running, ...pendingKeys], [running, pendingKeys]);
  useLogsBridge({ logs, projects, active: logActiveKeys, stopping: backendStopping, clear: clearSharedLogs });
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<string>('logs-dock-requested', event => {
      if (disposed) return;
      setSelected(event.payload); setEditorOpened(true); setView('editor');
    }, { target: 'main' }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; stop?.(); };
  }, []);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [compact, setCompact] = useState(storedCompact);
  const [recentIds, setRecentIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('devflow-recent') || '[]') as string[]; } catch { return []; } });
  const [confirm, setConfirm] = useState<{ title: string; description: string; confirmText: string; destructive?: boolean; action: () => void } | null>(null);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [serviceCandidates, setServiceCandidates] = useState<Service[] | null>(null);
  const [discoveringServices, setDiscoveringServices] = useState(false);
  const [serviceSuggestions, setServiceSuggestions] = useState<Record<string, Service>>({});
  const [healthSnapshots, setHealthSnapshots] = useState<Record<string, HealthSnapshot>>({});
  const healthRequestedAt = useRef<Record<string, number>>({});
  const healthStartedAt = useRef<Record<string, number>>({});
  const healthEpoch = useRef(0);

  const project = projects.find(item => item.id === selected);
  const projectLogs = useMemo(() => selected ? logs.filter(line => line.projectId === selected || (!!line.incidentId && !line.projectId)) : [], [logs, selected]);
  useEffect(() => { setFilter('all'); setSearch(''); }, [selected]);
  const repeatedErrors = useMemo(() => new Map(groupLogs(logs).filter(group => group.category === 'error' && group.repeatCount >= 3)
    .map(group => [serviceKey(group.entries[0].projectId, group.entries[0].serviceId), group.entries[0].runId])), [logs]);
  const runningCount = running.filter(key => projects.some(item => item.services.some(service => serviceKey(item.id, service.id) === key))).length;
  const projectRunning = project?.services.filter(service => running.includes(serviceKey(project.id, service.id))).length || 0;
  const projectActive = project?.services.filter(service => running.includes(serviceKey(project.id, service.id)) || pendingKeys.includes(serviceKey(project.id, service.id))).length || 0;
  const logProjects = useMemo(() => new Set(logs.map(line => line.projectId)), [logs]);
  const recentProjects = recentIds.map(id => projects.find(item => item.id === id)).filter((item): item is Project => Boolean(item));

  useShortcuts({ navigate: setView, search: () => setQuickSearchOpen(true), logsSearch: () => { if (view !== 'logs' || !logSearchRef.current) return false; logSearchRef.current.focus(); return true; }, error: setError });
  useEffect(() => {
    const navigate = (event: Event) => setView((event as CustomEvent<View>).detail);
    window.addEventListener('devflow-guide-navigate', navigate);
    return () => window.removeEventListener('devflow-guide-navigate', navigate);
  }, []);

  const refreshServiceState = async () => {
    const [active, stopping] = await Promise.all([
      invoke<string[]>('running_services'),
      invoke<string[]>('stopping_services'),
    ]);
    setRunning(active);
    setBackendStopping(stopping);
    return active;
  };

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('devflow-theme', theme); } catch { /* preference remains in memory */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.density = compact ? 'compact' : 'comfortable'; try { localStorage.setItem('devflow-compact', String(compact)); } catch { /* preference remains in memory */ } }, [compact]);
  useEffect(() => {
    notifications.onSystemEvent = entry => setLogs(current => appendLog(current, entry));
    const flush = () => notifications.flush();
    window.addEventListener('pagehide', flush);
    return () => { notifications.onSystemEvent = undefined; window.removeEventListener('pagehide', flush); notifications.flush(); };
  }, [notifications]);
  useEffect(() => {
    for (const target of projects) for (const service of target.services) {
      const key = serviceKey(target.id, service.id);
      if (!running.includes(key)) continue;
      const snapshot = healthSnapshots[key];
      if (snapshot) notifications.sample(target.id, service.id, snapshot);
    }
  }, [healthSnapshots, projects, running, notifications]);
  useEffect(() => {
    if (/^Could not (?:refresh service status|listen|load)/.test(error)) notifications.record({ reason: 'application', message: error });
  }, [error, notifications]);
  useEffect(() => {
    let mounted = true;
    let dispose: (() => void) | undefined;
    let disposeExit: (() => void) | undefined;
    let disposeDiagnostic: (() => void) | undefined;
    let disposeBatch: (() => void) | undefined;
    const initialize = async () => {
      try {
        dispose = await listen<LogLine>('service-log', event => {
          if (!mounted) return;
          if (!acceptSource(event.payload)) return;
          // ANSI decoding is stateful: never execute it inside a replayable React updater.
          const entry = normalizeAnsiLog({ ...event.payload, receivedAt: event.payload.receivedAt ?? Date.now() });
          setLogs(current => appendLog(current, entry));
          if (event.payload.stream === 'system') refreshServiceState().catch(() => {});
        });
        if (!mounted) { dispose?.(); return; }
        disposeBatch = await listen<ServiceLogBatch>('service-log-batch', event => {
          if (!mounted) return;
          const { lines, ...source } = event.payload;
          const entries = lines.map(line => ({ ...source, ...line })).filter(acceptSource).map(normalizeAnsiLog);
          if (entries.length) setLogs(current => appendLogs(current, entries));
        });
        if (!mounted) { dispose?.(); disposeBatch?.(); return; }
        disposeDiagnostic = await listen<Diagnostic>('service-diagnostic', event => { if (mounted) notifications.diagnostic(event.payload); });
        if (!mounted) { dispose?.(); disposeBatch?.(); disposeDiagnostic?.(); return; }
        disposeExit = await listen<ServiceExit>('service-exit', event => {
          if (!mounted) return;
          const key = serviceKey(event.payload.projectId, event.payload.serviceId);
          if (event.payload.runId && activeRuns.current.has(key) && activeRuns.current.get(key) !== event.payload.runId) return;
          latestExits.current.set(key, event.payload);
          notifications.exit(event.payload);
          // Root failure remains visible even while owned descendants are being cleaned up.
          if (!event.payload.stopRequested) setServiceExits(current => ({ ...current, [key]: event.payload }));
          setBulkProgress(current => { const next = { ...current }; delete next[key]; return next; });
          refreshServiceState().then(() => {
            if (!mounted) return;
            if (event.payload.runId && activeRuns.current.has(key) && activeRuns.current.get(key) !== event.payload.runId) return;
            if (event.payload.stopRequested) setServiceExits(current => { const next = { ...current }; delete next[key]; return next; });
          }).catch(cause => { if (mounted) setError(`Could not refresh service status: ${errorMessage(cause)}`); });
        });
      } catch (cause) {
        if (mounted) { setError(errorMessage(cause)); notifications.record({ reason: 'application', message: 'DevFlow could not subscribe to service events. Restart DevFlow to restore log and lifecycle collection.' }); }
      }
      if (!mounted) { dispose?.(); disposeBatch?.(); disposeExit?.(); disposeDiagnostic?.(); return; }
      projectStore.load().then(items => { if (mounted) setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id || ''); }).catch(() => { /* load error is shown with Retry Load */ });
      refreshServiceState().catch(() => {});
    };
    void initialize();
    return () => { mounted = false; dispose?.(); disposeBatch?.(); disposeExit?.(); disposeDiagnostic?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    const epoch = ++healthEpoch.current;
    const active = new Map<string, { service: Service; config: ServiceHealthConfig }>();
    for (const target of projects) for (const service of target.services) {
      const key = serviceKey(target.id, service.id);
      const config = service.healthCheck || defaultHealthConfig(service);
      if (!running.includes(key)) { delete healthRequestedAt.current[key]; delete healthStartedAt.current[key]; setHealthSnapshots(current => { if (!current[key]) return current; const next = { ...current }; delete next[key]; return next; }); continue; }
      active.set(key, { service, config });
      if (!healthStartedAt.current[key]) healthStartedAt.current[key] = Date.now();
      if (config.enabled) setHealthSnapshots(current => ({ ...current, [key]: { status: 'checking' } }));
    }
    const poll = async () => {
      const now = Date.now();
      await Promise.all([...active.entries()].filter(([key, item]) => item.config.enabled && now - (healthRequestedAt.current[key] || 0) >= item.config.intervalSeconds * 1000).map(async ([key, item]) => {
        healthRequestedAt.current[key] = now;
        try {
          const result = await invoke<HealthSnapshot>('check_service_health', { service: { ...item.service, healthCheck: item.config } });
          if (disposed || epoch !== healthEpoch.current || !running.includes(key)) return;
          const withinGrace = Date.now() - (healthStartedAt.current[key] || Date.now()) < 15000;
          setHealthSnapshots(current => ({ ...current, [key]: result.status === 'unhealthy' && withinGrace ? { ...result, status: 'checking', error: 'Starting server; waiting for the endpoint to become ready.' } : result }));
        } catch (cause) {
          if (!disposed) setHealthSnapshots(current => ({ ...current, [key]: { status: 'unknown', error: `Health check unavailable: ${errorMessage(cause)}` } }));
        }
      }));
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [projects, running]);

  const retryLoad = async () => {
    try {
      const items = await projectStore.load();
      setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id || '');
      setError('');
    } catch { /* keep the failed state and the original file for another retry */ }
  };

  const selectProject = (id: string) => {
    setError(''); setActionMessage('');
    setSelected(id); setFilter('all'); setSearch('');
    setRecentIds(current => { const next = [id, ...current.filter(value => value !== id)].slice(0, 5); try { localStorage.setItem('devflow-recent', JSON.stringify(next)); } catch { /* list remains in memory */ } return next; });
  };
  const savedMessage = () => setActionMessage(projectStore.current.dirty ? 'Newer edits still need saving' : 'Changes saved');
  const importProject = async () => {
    if (projectStore.current.status !== 'ready') { setError('Retry Load before importing a project.'); return; }
    try { const root = await open({ directory: true, multiple: false, title: 'Select project root' }); if (!root || Array.isArray(root)) return; const detected = await invoke<Project>('detect_project', { root }); await projectStore.updateAndSave(current => [...current, detected]); selectProject(detected.id); setView('projects'); setError(''); savedMessage(); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const editService = (id: string, field: 'name' | 'cwd' | 'program' | 'args' | 'role' | 'framework' | 'host' | 'port' | 'entryPoint', value: string) => {
    if (!project || projectStore.current.status !== 'ready') return;
    projectStore.edit(current => current.map(item => item.id === project.id ? { ...item, services: item.services.map(service => {
      if (service.id !== id) return service;
      if (field === 'args') return { ...service, args: value.split('\n').filter(Boolean) };
      if (field === 'host') return { ...service, host: value || undefined, ...(isUvicornCommand(service) && value.trim() ? { args: setCommandFlag(service.args, '--host', value.trim()) } : {}) };
      if (field === 'port') return { ...service, port: value ? Number(value) : undefined, ...(isUvicornCommand(service) && value ? { args: setCommandFlag(service.args, '--port', value) } : {}) };
      if (field === 'entryPoint') {
        const oldTarget = service.entryPoint;
        const isGeneratedCommand = service.framework === 'FastAPI' && (!service.args.length || service.args.includes(oldTarget || '__missing__'));
        return { ...service, entryPoint: value, ...(isGeneratedCommand && value.trim() ? { host: service.host || '127.0.0.1', port: service.port || 8000, args: ['-m', 'uvicorn', value.trim(), '--reload', '--host', service.host || '127.0.0.1', '--port', String(service.port || 8000)] } : {}) };
      }
      if (field === 'role' || field === 'framework') return { ...service, [field]: value, reviewNote: service.reviewNote?.includes('Manual override') ? `${service.reviewNote} ${field}` : `Manual override: ${field} set by the user.` };
      return { ...service, [field]: value };
    }) } : item));
    setServiceErrors(current => { const next = { ...current }; delete next[serviceKey(project.id, id)]; return next; });
  };
  const applyCommandSuggestion = (service: Service, suggestion: Service) => {
    if (!project || running.includes(serviceKey(project.id, service.id)) || startingKeys.current.has(serviceKey(project.id, service.id)) || stoppingKeys.current.has(serviceKey(project.id, service.id))) { setError(`Stop ${service.name} before changing its command.`); return; }
    projectStore.edit(current => current.map(item => item.id === project.id ? { ...item, services: item.services.map(value => value.id === service.id ? { ...value, program: suggestion.program, args: suggestion.args, host: suggestion.host ?? commandFlag(suggestion.args, '--host'), port: suggestion.port ?? (Number(commandFlag(suggestion.args, '--port')) || undefined), interpreterPath: suggestion.interpreterPath, entryPoint: suggestion.entryPoint, runOptions: suggestion.runOptions } : value) } : item));
    setServiceSuggestions(current => { const next = { ...current }; delete next[serviceKey(project.id, service.id)]; return next; });
    setError(''); setActionMessage(`Verified command applied to ${service.name}. Save changes to persist it.`);
  };
  const selectRunOption = (service: Service, option: RunOption) => {
    if (!project || running.includes(serviceKey(project.id, service.id)) || startingKeys.current.has(serviceKey(project.id, service.id)) || stoppingKeys.current.has(serviceKey(project.id, service.id))) { setError(`Stop ${service.name} before changing its command.`); return; }
    applyCommandSuggestion(service, { ...service, program: option.program, args: option.args, interpreterPath: option.interpreterPath, entryPoint: option.entryPoint });
  };
  const requestApplySuggestion = (service: Service, suggestion: Service) => {
    const changed = service.program !== suggestion.program || service.args.join('\n') !== suggestion.args.join('\n');
    if (!changed) return;
    setConfirm({ title: `Apply suggested command to ${service.name}?`, description: 'This replaces only the executable and arguments with the latest verified suggestion for the current framework and working directory. The service name, role, working directory, port, and other fields remain unchanged.', confirmText: 'Apply suggested command', action: () => applyCommandSuggestion(service, suggestion) });
  };
  const changeFramework = async (service: Service, framework: string) => {
    if (!project || running.includes(serviceKey(project.id, service.id)) || startingKeys.current.has(serviceKey(project.id, service.id)) || stoppingKeys.current.has(serviceKey(project.id, service.id))) { setError(`Stop ${service.name} before changing its framework.`); return; }
    const nextRole = ['FastAPI', 'Flask', 'Django'].includes(framework) ? 'backend' : ['Next.js', 'Vite/React'].includes(framework) ? 'frontend' : service.role || 'other';
    projectStore.edit(current => current.map(item => item.id === project.id ? { ...item, services: item.services.map(value => value.id === service.id ? { ...value, framework, role: nextRole, reviewNote: 'Manual override: framework and role selected by the user.' } : value) } : item));
    setServiceSuggestions(current => { const next = { ...current }; delete next[serviceKey(project.id, service.id)]; return next; });
    if (!['FastAPI', 'Flask', 'Django'].includes(framework)) return;
    try {
      const suggestion = await suggestService(service.cwd, framework);
      if (!suggestion) { setActionMessage(`No verified ${framework} command found for ${service.cwd}.`); return; }
      projectStore.edit(current => current.map(item => item.id === project.id ? { ...item, services: item.services.map(value => value.id === service.id ? { ...value, runOptions: suggestion.runOptions, confidence: suggestion.confidence, interpreterPath: value.interpreterPath || suggestion.interpreterPath, entryPoint: value.entryPoint || suggestion.entryPoint } : value) } : item));
      if (!service.program.trim() && !service.args.length) applyCommandSuggestion({ ...service, framework }, suggestion);
      else { setServiceSuggestions(current => ({ ...current, [serviceKey(project.id, service.id)]: suggestion })); setActionMessage(`Verified ${framework} command found. Apply it explicitly to replace the current command.`); }
    } catch (cause) { setError(`Could not calculate a ${framework} suggestion: ${errorMessage(cause)}`); }
  };
  const resetCommands = async (service: Service) => {
    if (!project || running.includes(serviceKey(project.id, service.id)) || startingKeys.current.has(serviceKey(project.id, service.id)) || stoppingKeys.current.has(serviceKey(project.id, service.id))) { setError(`Stop ${service.name} before resetting its command.`); return; }
    try {
      const stored = service.runOptions?.find(option => option.verified && option.program.trim() && option.args.length);
      const suggestion = stored ? { ...service, program: stored.program, args: stored.args, host: commandFlag(stored.args, '--host'), port: Number(commandFlag(stored.args, '--port')) || undefined, interpreterPath: stored.interpreterPath, entryPoint: stored.entryPoint } : await suggestService(service.cwd, service.framework || 'Custom');
      if (!suggestion?.program.trim() || !suggestion.args.length) { setActionMessage(`No verified command is available for ${service.name}; existing values were left unchanged.`); return; }
      requestApplySuggestion(service, suggestion);
    } catch (cause) { setError(`Could not reset ${service.name}: ${errorMessage(cause)}`); }
  };
  const save = async () => { setActionMessage(''); try { await projectStore.save(); setError(''); savedMessage(); } catch (cause) { setError(`Could not save project configuration: ${errorMessage(cause)}`, true); } };
  const addService = async () => {
    if (!project || projectStore.current.status !== 'ready') return;
    setDiscoveringServices(true);
    try {
      const detected = await invoke<Service[]>('discover_services', { root: project.root });
      setServiceCandidates(detected.filter(candidate => !isConfiguredService(candidate, project.services)));
      setError('');
    } catch (cause) { setError(`Could not discover services: ${errorMessage(cause)}`); }
    finally { setDiscoveringServices(false); }
  };
  const addSelectedService = async (service: Service) => {
    if (!project || projectStore.current.status !== 'ready') return;
    await projectStore.updateAndSave(current => current.map(item => {
      if (item.id !== project.id) return item;
      if (isConfiguredService(service, item.services)) throw new Error('A service already uses this working directory. Edit the existing service or choose another folder.');
      return { ...item, services: [...item.services, service] };
    }));
    setServiceCandidates(null);
    setError('');
    setBulkSummary({ projectId: project.id, text: 'Service configuration saved. Review the command before starting.', failed: false });
  };
  const rescanServices = async () => {
    if (!project || projectStore.current.status !== 'ready' || discoveringServices) return;
    setDiscoveringServices(true);
    try {
      const detected = await invoke<Service[]>('discover_services', { root: project.root });
      const additions = detected.filter(candidate => !isConfiguredService(candidate, project.services));
      const activeServices = new Set(await refreshServiceState());
      let enriched = 0;
      const pendingSuggestions: Record<string, Service> = {};
      projectStore.edit(current => current.map(item => item.id === project.id ? { ...item, services: [
        ...item.services.map(service => {
          const candidate = detected.find(value => value.id.toLowerCase() === service.id.toLowerCase() || normalizedServicePath(value.cwd) === normalizedServicePath(service.cwd));
          const key = serviceKey(item.id, service.id);
          if (!candidate || activeServices.has(key) || running.includes(key) || startingKeys.current.has(key) || stoppingKeys.current.has(key)) return service;
          const next = { ...service,
            role: service.reviewNote?.startsWith('Manual override: role') ? service.role : candidate.role,
            framework: service.reviewNote?.startsWith('Manual override: framework') ? service.framework : candidate.framework,
            host: service.host || candidate.host,
            port: service.port || candidate.port,
            program: service.program.trim() ? service.program : candidate.program,
            args: service.args.length ? service.args : candidate.args,
            interpreterPath: service.interpreterPath || candidate.interpreterPath,
            entryPoint: service.entryPoint || candidate.entryPoint,
            runOptions: candidate.runOptions?.length ? candidate.runOptions : service.runOptions,
            confidence: service.confidence || candidate.confidence,
            reviewNote: service.program.trim() || service.args.length ? service.reviewNote : candidate.reviewNote,
          };
          if (next.program !== service.program || next.args.join('\n') !== service.args.join('\n') || next.role !== service.role || next.framework !== service.framework || next.interpreterPath !== service.interpreterPath || next.entryPoint !== service.entryPoint) enriched += 1;
          if (service.program.trim() && service.args.length && (candidate.program !== service.program || candidate.args.join('\n') !== service.args.join('\n'))) pendingSuggestions[serviceKey(item.id, service.id)] = candidate;
          return next;
        }),
        ...additions.filter(candidate => !isConfiguredService(candidate, item.services)),
      ] } : item));
      setServiceSuggestions(current => ({ ...current, ...pendingSuggestions }));
      const changed = additions.length + enriched;
      setBulkSummary({ projectId: project.id, text: changed ? `Rescan found ${additions.length} new service${additions.length === 1 ? '' : 's'} and populated ${enriched} existing command${enriched === 1 ? '' : 's'}. Review and save changes.` : 'Rescan complete: no new services or verified command suggestions found.', failed: false });
      setError('');
    } catch (cause) { setError(`Could not rescan services: ${errorMessage(cause)}`); }
    finally { setDiscoveringServices(false); }
  };
  const suggestService = useCallback((cwd: string, framework: string) => invoke<Service | null>('suggest_service', { root: cwd, projectRoot: cwd, framework }), []);
  const renameProject = (target: Project) => {
    if (projectStore.current.status !== 'ready') { setError('Retry Load before renaming a project.'); return; }
    setActionMessage('');
    setRenaming(target);
  };
  const saveProjectName = async (name: string) => {
    if (!renaming) return;
    try {
      await projectStore.renameProject(renaming.id, name);
      setRenaming(null);
      setError('');
      setActionMessage(projectStore.current.dirty ? 'Project renamed; newer edits still need saving' : 'Project renamed');
    } catch (cause) {
      setError(`Could not rename project: ${errorMessage(cause)}`);
      throw cause;
    }
  };
  const removeProject = (target: Project) => {
    if (projectStore.current.status !== 'ready') { setError('Retry Load before removing a project.'); return; }
    if (bulkLock.current || removeLock.current) return;
    const hasActiveService = target.services.some(service => running.includes(serviceKey(target.id, service.id)) || startingKeys.current.has(serviceKey(target.id, service.id)) || stoppingKeys.current.has(serviceKey(target.id, service.id)));
    if (hasActiveService) { setError(`Stop all running services in "${target.name}" before removing it.`); return; }
    setConfirm({
      title: `Remove "${target.name}"?`,
      description: `This removes "${target.name}" from DevFlow's saved project list. Your project folder, source files, and Git history will not be changed.`,
      confirmText: 'Remove project',
      destructive: true,
      action: () => {
        if (removeLock.current) return;
        removeLock.current = true;
        setBusy(true);
        setActionMessage('');
        void (async () => {
          try {
            const savedProject = projectStore.current.projects.find(item => item.id === target.id);
            if (!savedProject) throw new Error('Project is no longer saved.');
            const active = await invoke<string[]>('running_services');
            if (bulkLock.current || savedProject.services.some(service => active.includes(serviceKey(target.id, service.id)) || startingKeys.current.has(serviceKey(target.id, service.id)) || stoppingKeys.current.has(serviceKey(target.id, service.id)))) {
              throw new Error('Stop all running or starting services before removing this project.');
            }
            await projectStore.updateAndSave(current => current.filter(item => item.id !== target.id));
            setSelected(current => {
              if (current !== target.id) return current;
              const remaining = projectStore.current.projects;
              return remaining[0]?.id ?? '';
            });
            setLogs(current => current.filter(line => line.projectId !== target.id));
            setServiceErrors(current => {
              const next = { ...current };
              target.services.forEach(service => { delete next[serviceKey(target.id, service.id)]; });
              return next;
            });
            setServiceExits(current => {
              const next = { ...current };
              target.services.forEach(service => { delete next[serviceKey(target.id, service.id)]; });
              return next;
            });
            setRecentIds(current => current.filter(id => id !== target.id));
            try { localStorage.setItem('devflow-recent', JSON.stringify(recentIds.filter(id => id !== target.id))); } catch { /* preference remains in memory */ }
            setError('');
            setActionMessage(`"${target.name}" removed from DevFlow`);
          } catch (cause) {
            setError(`Could not remove "${target.name}": ${errorMessage(cause)} The project has been kept.`);
          } finally {
            removeLock.current = false;
            setBusy(false);
          }
        })();
      },
    });
  };
  const removeService = (service: Service) => {
    if (!project || projectStore.current.status !== 'ready') return;
    if (running.includes(serviceKey(project.id, service.id)) || startingKeys.current.has(serviceKey(project.id, service.id)) || stoppingKeys.current.has(serviceKey(project.id, service.id))) { setError(`Stop ${service.name} before removing its DevFlow configuration.`); return; }
    setConfirm({ title: `Remove ${service.name}?`, description: 'This removes the service from the saved project configuration. It does not delete project files.', confirmText: 'Remove service', destructive: true, action: () => { void projectStore.updateAndSave(current => current.map(item => item.id === project.id ? { ...item, services: item.services.filter(value => value.id !== service.id) } : item)).then(() => { setError(''); savedMessage(); }).catch(cause => setError(errorMessage(cause))); } });
  };
  const syncPendingKeys = () => setPendingKeys([...new Set([...startingKeys.current, ...stoppingKeys.current])]);
  const start = async (target: Project, service: Service) => {
    const key = serviceKey(target.id, service.id);
    if (removeLock.current || (bulkLock.current && cancelledBulkStarts.current.has(key)) || startingKeys.current.has(key) || stoppingKeys.current.has(key)) return false;
    startingKeys.current.add(key);
    cancelledStarts.current.delete(key);
    syncPendingKeys();
    setBulkProgress(current => { const next = { ...current }; delete next[key]; return next; });
    setBulkSummary(null);
    activeRuns.current.delete(key);
    latestExits.current.delete(key);
    setServiceErrors(current => { const next = { ...current }; delete next[key]; return next; });
    setServiceExits(current => { const next = { ...current }; delete next[key]; return next; });
    try {
      const runId = await invoke<string>('start_service', { projectId: target.id, service });
      activeRuns.current.set(key, runId);
      if (latestExits.current.get(key)?.runId !== runId) notifications.started(target.id, service.id);
      setServiceExits(current => { if (current[key]?.runId === runId) return current; const next = { ...current }; delete next[key]; return next; });
      setError('');
      return true;
    } catch (cause) {
      if (!cancelledStarts.current.has(key)) {
        notifications.record({ reason: 'start-failed', projectId: target.id, serviceId: service.id, message: `${restartingKeys.current.has(key) ? 'Restart' : 'Start'} failed: ${errorMessage(cause)}` });
        setServiceErrors(current => ({ ...current, [key]: `Could not start: ${errorMessage(cause)} Check the executable, working directory, and logs.` }));
        setError(errorMessage(cause));
      }
      return false;
    } finally {
      try { await refreshServiceState(); }
      catch (cause) { setError(`Could not refresh service status: ${errorMessage(cause)}`); }
      startingKeys.current.delete(key);
      syncPendingKeys();
    }
  };
  const stop = async (target: Project, service: Service) => {
    const key = serviceKey(target.id, service.id);
    if (stoppingKeys.current.has(key)) return false;
    stoppingKeys.current.add(key);
    if (startingKeys.current.has(key)) cancelledStarts.current.add(key);
    syncPendingKeys();
    setBulkProgress(current => { const next = { ...current }; delete next[key]; return next; });
    setBulkSummary(null);
    try {
      await invoke('stop_service', { projectId: target.id, serviceId: service.id });
      notifications.stopped(target.id, service.id);
      setServiceErrors(current => { const next = { ...current }; delete next[key]; return next; });
      setError('');
      return true;
    } catch (cause) {
      notifications.record({ reason: 'stop-failed', projectId: target.id, serviceId: service.id, message: `Service cleanup could not be confirmed: ${errorMessage(cause)}` });
      setServiceErrors(current => ({ ...current, [key]: `Could not confirm cleanup: ${errorMessage(cause)} Retry Stop or inspect the process logs.` }));
      setError(errorMessage(cause));
      return false;
    } finally {
      stoppingKeys.current.delete(key);
      syncPendingKeys();
      try { await refreshServiceState(); }
      catch (cause) { setError(`Could not refresh service status: ${errorMessage(cause)}`); }
    }
  };
  const requestStop = (target: Project, services: Service[]) => {
    if (services.length === 0) return;
    setConfirm({ title: services.length === 1 ? `Stop ${services[0].name}?` : `Stop ${services.length} services?`, description: 'DevFlow terminates only this service’s owned process tree. Unsaved process state could be lost.', confirmText: services.length === 1 ? 'Stop service' : 'Stop services', destructive: true, action: () => { void (async () => { for (const service of services) await stop(target, service); })(); } });
  };
  const restart = (target: Project, service: Service) => {
    if (bulkLock.current) return;
    setConfirm({ title: `Restart ${service.name}?`, description: 'Restart first terminates and confirms cleanup of the service process tree, then starts one replacement.', confirmText: 'Restart service', destructive: true, action: () => { void (async () => { const key = serviceKey(target.id, service.id); if (restartingKeys.current.has(key) || bulkLock.current) return; restartingKeys.current.add(key); setBusy(true); try { if (await stop(target, service)) await start(target, service); } finally { restartingKeys.current.delete(key); setBusy(false); } })(); } });
  };
  const runProject = async (target: Project, mode: BulkMode, targetServices: Service[] = target.services) => {
    if (bulkLock.current || removeLock.current) return;
    bulkLock.current = true;
    for (const service of targetServices) cancelledBulkStarts.current.add(serviceKey(target.id, service.id));
    if (mode === 'start') cancelledBulkStarts.current.clear();
    setBusy(true);
    setBulkSummary(null);
    setBulkProgress(current => Object.fromEntries(Object.entries(current).filter(([key]) => !targetServices.some(service => key === serviceKey(target.id, service.id)))));
    try {
      const results = await runBulkAction({
        mode, projectId: target.id, services: targetServices,
        getActive: refreshServiceState,
        isStarting: key => startingKeys.current.has(key),
        isCancelled: key => cancelledBulkStarts.current.has(key),
        execute: async service => {
          const key = serviceKey(target.id, service.id);
          if (mode === 'start') { if (!await start(target, service)) throw new Error('Start failed; see the service error.'); }
          else { if (!await stop(target, service)) throw new Error('Stop could not confirm process tree cleanup; see the service error.'); }
          setServiceErrors(current => { const next = { ...current }; delete next[key]; return next; });
          if (mode === 'start') setServiceExits(current => { const next = { ...current }; delete next[key]; return next; });
        },
        onProgress: (key, result) => {
          setBulkProgress(current => ({ ...current, [key]: result }));
          if (result.step === 'failed') setServiceErrors(current => ({ ...current, [key]: current[key] || result.detail }));
        },
      });
      const values = Object.values(results);
      const completed = values.filter(result => result.step === (mode === 'start' ? 'launched' : 'stopped')).length;
      const skipped = values.filter(result => result.step === 'skipped').length;
      const failed = values.filter(result => result.step === 'failed').length;
      const verb = mode === 'start' ? 'launched' : 'stopped';
      setBulkSummary({ projectId: target.id, text: `${completed} ${verb}, ${skipped} skipped, ${failed} failed.`, failed: failed > 0 });
      if (failed) setError(`${mode === 'start' ? 'Start All' : 'Stop All'} finished with ${failed} failure${failed === 1 ? '' : 's'}. See the service results below.`);
      else setError('');
    } finally {
      try { await refreshServiceState(); }
      catch (cause) { setError(`Could not refresh service status: ${errorMessage(cause)}`); }
      bulkLock.current = false;
      setBusy(false);
    }
  };
  const requestStopAll = (target: Project) => {
    if (bulkLock.current) return;
    setConfirm(stopAllConfirmation(target, () => { void runProject(target, 'stop'); }));
  };
  const editorServiceSnapshot = useMemo(() => ({ busy, stopPending: busy, activeKeys: [...new Set([...running, ...pendingKeys, ...backendStopping, ...Object.keys(bulkProgress).filter(key => bulkProgress[key].step === 'queued')])], stoppingKeys: [...stoppingKeys.current],
    states: projects.map(target => {
      const issues = { ...serviceErrors };
      target.services.forEach(service => {
        const key = serviceKey(target.id, service.id), exit = serviceExits[key];
        if (!issues[key] && exit && !exit.stopRequested && exit.exitCode !== 0) issues[key] = `Command exited with code ${exit.exitCode ?? 'unavailable'}. Review Logs and the configured command, then retry.`;
      });
      return projectServiceState(target, running, [...startingKeys.current], [...stoppingKeys.current], issues, backendStopping);
    }),
  }), [projects, running, pendingKeys, backendStopping, serviceErrors, serviceExits, busy, bulkProgress]);
  useProjectServicesBridge(editorServiceSnapshot, async (projectId, mode) => {
    const target = projects.find(item => item.id === projectId);
    if (!target) throw new Error('Project no longer exists. Select another project.');
    // Stop requests from the floating editor have already used the shared confirmation.
    if (mode === 'start') { void runProject(target, 'start').catch(cause => setError(errorMessage(cause))); }
    else { const scope = mode === 'stop' ? 'all' : mode.slice(5) as LogStopScope; const scoped = logStopServices(target.services, scope); if (scoped.length) await runProject(target, 'stop', scoped); }
  });
  const requestLogStop = (target: Project, scope: LogStopScope) => {
    const scoped = logStopServices(target.services, scope);
    if (bulkLock.current) return;
    if (!scoped.length) return;
    setConfirm(stopScopeConfirmation(target, scope, scoped, () => { void runProject(target, 'stop', scoped).catch(cause => setError(errorMessage(cause))); }));
  };
  const logStopControls = (target: Project) => target.id ? <LogsServiceControls project={target} /> : null;
  const openDirectory = async (path: string, target: 'terminal' | 'folder') => {
    try { await invoke('open_directory', { path, target }); setActionMessage(target === 'terminal' ? 'Terminal opened' : 'Folder opened'); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const openInAiCli = async (path: string, cli: 'codex' | 'claude') => {
    try { await invoke('open_in_ai_cli', { path, cli }); setActionMessage(`${cli === 'codex' ? 'Codex' : 'Claude'} opened in new terminal`); }
    catch (cause) { setError(errorMessage(cause)); }
  };
  const copyDirectoryPath = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setActionMessage('Directory path copied'); return true; }
    catch (cause) { setError(`Could not copy directory path: ${errorMessage(cause)}`); return false; }
  };
  const editHealth = (target: Project, service: Service, changes: Partial<ServiceHealthConfig>) => {
    const key = serviceKey(target.id, service.id);
    if (running.includes(key) || startingKeys.current.has(key) || stoppingKeys.current.has(key)) { setError(`Stop ${service.name} before changing health-check configuration.`); return; }
    projectStore.edit(current => current.map(item => item.id === target.id ? { ...item, services: item.services.map(value => value.id === service.id ? { ...value, healthCheck: { ...defaultHealthConfig(value), ...(value.healthCheck || {}), ...changes } } : value) } : item));
    if (changes.enabled === false) setHealthSnapshots(current => ({ ...current, [key]: { status: 'disabled' } }));
    else if (changes.enabled === true) setHealthSnapshots(current => ({ ...current, [key]: { status: 'checking' } }));
  };
  const checkHealthNow = async (target: Project, service: Service) => {
    const key = serviceKey(target.id, service.id);
    if (!running.includes(key)) return;
    const config = service.healthCheck || defaultHealthConfig(service);
    if (!config.enabled) return;
    const epoch = healthEpoch.current;
    setHealthSnapshots(current => ({ ...current, [key]: { status: 'checking' } }));
    try {
      const result = await invoke<HealthSnapshot>('check_service_health', { service: { ...service, healthCheck: config } });
      if (epoch === healthEpoch.current && running.includes(key)) setHealthSnapshots(current => ({ ...current, [key]: result }));
    } catch (cause) { setHealthSnapshots(current => ({ ...current, [key]: { status: 'unknown', error: errorMessage(cause) } })); }
  };
  const servicePresentation = (target: Project, service: Service) => {
    const key = serviceKey(target.id, service.id);
    const isRunning = running.includes(key);
    const exit = serviceExits[key];
    const outcome = exit && !exit.stopRequested ? exit.exitCode === 0 ? 'exited' as const : 'failed' as const : undefined;
    const repeated = isRunning && repeatedErrors.has(key) && (!activeRuns.current.has(key) || repeatedErrors.get(key) === activeRuns.current.get(key));
    const issue = serviceErrors[key] || (outcome ? `${service.name} ${outcome === 'failed' ? 'failed' : 'exited'} — command exited with code ${exit.exitCode ?? 'unavailable'}. Review the diagnostic output below.` : repeated ? `${service.name} is running but emitting repeated errors. No restart has been requested by DevFlow.` : undefined);
    return { outcome, issue, stopping: stoppingKeys.current.has(key) || backendStopping.includes(key), suggestion: serviceSuggestions[key], onFrameworkChange: (framework: string) => void changeFramework(service, framework), onApplySuggestion: (suggestion: Service) => requestApplySuggestion(service, suggestion), onSelectOption: (option: RunOption) => selectRunOption(service, option), onReset: () => void resetCommands(service), health: healthSnapshots[key], healthConfig: service.healthCheck || defaultHealthConfig(service), onHealthChange: (changes: Partial<ServiceHealthConfig>) => editHealth(target, service, changes), onCheckNow: () => void checkHealthNow(target, service) };
  };
  const serviceAlerts = (target: Project) => <div className="service-log-issues">{target.services.map(service => {
    const { issue } = servicePresentation(target, service); if (!issue) return null;
    const key = serviceKey(target.id, service.id), alive = running.includes(key) || startingKeys.current.has(key);
    return <div key={key} className="service-log-issue" role="status"><span>{issue}</span><Button disabled={alive} title={alive ? 'Stop the service before editing its command' : 'Edit the configured executable'} onClick={() => { setView('projects'); requestAnimationFrame(() => document.getElementById(`service-command-${service.id}`)?.focus()); }}>Edit Command</Button><Button disabled={stoppingKeys.current.has(key) || (!alive && busy)} onClick={() => alive ? requestStop(target, [service]) : void start(target, service)}>{alive ? 'Stop' : 'Retry'}</Button></div>;
  })}</div>;
  const logWorkspace = (target: Project) => <LogViewer serviceControls={logStopControls(target)} focusIncident={logFocus} project={target} logs={projectLogs} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} searchRef={logSearchRef} autoScroll={autoScroll} setAutoScroll={setAutoScroll} onCopy={async (text, message) => { try { await writeLogClipboard(text); setError(''); setActionMessage(message); return true; } catch (cause) { setActionMessage(''); setError(`Could not copy logs: ${errorMessage(cause)}`); return false; } }} onExport={async text => { try { const saved = await exportLogText(target, text); setActionMessage(saved ? 'Logs exported' : 'Export cancelled'); return saved; } catch (cause) { setActionMessage(''); setError(`Could not export logs: ${errorMessage(cause)}`); return false; } }} onClear={entries => { const visible = new Set(entries); setLogs(current => current.filter(line => !visible.has(line as LogEntry))); setActionMessage('Matching log output cleared'); }} onOpenUrl={url => { invoke('open_local_url', { url }).catch(cause => setError(`Could not open local URL: ${errorMessage(cause)}`)); }} actionMessage={actionMessage} />;

  const openIncident = useCallback((incident: Incident) => {
    const { project: target, missing, filter: incidentFilter } = incidentDestination(incident, projects);
    if (missing) { setError('This incident belongs to a project that is no longer configured. Its details remain in Notifications.'); return; }
    if (target) setSelected(target.id);
    setFilter(incidentFilter);
    setSearch(''); setAutoScroll(false); setView('logs');
    // Raw output is session-only; retained system events provide an honest fallback.
    setLogs(current => current.some(line => line.incidentId === incident.id) ? current : appendLog(current, incidentLog(incident)));
    setLogFocus(current => ({ incidentId: incident.id, request: (current?.request || 0) + 1 }));
  }, [projects]);
  return <ProjectServicesContext.Provider value={{ ...editorServiceSnapshot, request: (target, mode) => { const current = projects.find(item => item.id === target.id); if (current) { if (mode === 'start') void runProject(current, 'start'); else requestLogStop(current, mode === 'stop' ? 'all' : mode.slice(5) as LogStopScope); } } }}><LogsContext.Provider value={{ logs, projects, active: [...running, ...pendingKeys], stopping: backendStopping, clear: clearSharedLogs, controls: logStopControls }}><div className="app-shell"><Sidebar view={view} setView={setView} projects={projects} selected={selected} selectProject={selectProject} runningCount={runningCount} theme={theme} setTheme={setTheme} importProject={() => void importProject()} /><main className="main-content"><div className="topline"><span>LOCAL DEVELOPMENT / DEVFLOW</span><span className="topline-right"><HelpLink section={view === 'editor' ? 'quick-editor' : view === 'system' ? 'system-monitor' : view} /><NotificationCenter store={notifications} projects={projects} onOpen={openIncident} /><span className="local-dot" /> ALL SYSTEMS LOCAL</span></div><OperationNotice message={error} dismiss={() => setError('')} /><SystemCenter active={view === 'system' || view === 'maintenance'} section={view === 'maintenance' ? 'maintenance' : 'system'} onSection={setView} onProjects={() => setView('projects')} />{projectSnapshot.status === 'loading' ? <div className="loading-state" role="status">Loading your workspace…</div> : projectSnapshot.status === 'failed' ? <Card className="settings-card"><h2>Could not load saved projects</h2><p role="alert">DevFlow could not read projects.json: {projectSnapshot.loadError}</p><p>Your saved file has not been changed. Check its permissions or JSON contents, then try loading again. Project changes are blocked until it loads successfully.</p><Button tone="primary" onClick={() => void retryLoad()}>Retry Load</Button></Card> : <>
    {view === 'overview' && <Overview projects={projects} recentProjects={recentProjects} project={project} running={running} pending={pendingKeys} stopping={backendStopping} errors={serviceErrors} exits={serviceExits} health={healthSnapshots} logProjects={logProjects} notifications={notifications} environment={environmentSummary} busy={busy} importProject={() => void importProject()} navigate={(next, id) => { if (id) selectProject(id); setView(next); }} start={target => { const current = projects.find(item => item.id === target.id); if (current) { selectProject(current.id); setView('projects'); void runProject(current, 'start'); } }} openIncident={openIncident} />}
    {view === 'projects' && <><header className="page-header"><div><span className="eyebrow">PROJECT WORKSPACES</span><h1>Projects<span className="accent-period">.</span></h1><p>Review commands before you run them. Every service stays in your control.</p></div><Button tone="primary" icon={<FolderPlus size={17} />} onClick={() => void importProject()}>Import project</Button></header>{project ? <><div className="project-heading"><div><span className="eyebrow">CURRENT PROJECT</span><h2>{project.name}</h2><p>{project.root}</p></div><div className="project-heading-actions"><ProjectShortcuts project={project} onTerminal={path => openDirectory(path, 'terminal')} onFolder={path => openDirectory(path, 'folder')} onCopyPath={copyDirectoryPath} onAiCli={openInAiCli} /><Status running={projectRunning > 0} /><Button icon={<Square size={16} />} disabled={busy || projectActive === 0} onClick={() => requestStopAll(project)}>Stop all</Button><Button tone="primary" icon={<Play size={16} />} disabled={busy || project.services.length === 0 || projectActive === project.services.length} onClick={() => void runProject(project, 'start')}>Start all</Button><Button icon={<Pencil size={15} />} disabled={busy} onClick={() => renameProject(project)}>Rename</Button><Button tone="danger" icon={<Trash2 size={15} />} disabled={busy || projectActive > 0} title={projectActive > 0 ? 'Stop all services before removing this project' : undefined} onClick={() => removeProject(project)}>Remove project</Button></div></div>{bulkSummary?.projectId === project.id && <p className={`bulk-summary ${bulkSummary.failed ? 'bulk-summary-error' : ''}`} role="status">{bulkSummary.text}</p>}<div className="section-heading"><div><span className="eyebrow">CONFIGURATION</span><h2>Services <span className="heading-count">{project.services.length}</span></h2></div><div className="toolbar-actions"><Button icon={<Save size={15} />} onClick={() => void save()} disabled={!dirty}>Save changes</Button><Button icon={<RefreshCw size={15} />} disabled={discoveringServices} onClick={() => void rescanServices()}>Rescan services</Button><Button icon={<FolderPlus size={15} />} disabled={discoveringServices} onClick={() => void addService()}>Add service</Button></div></div>{dirty && <p className="unsaved-note" role="status">Unsaved changes. Save before leaving this session.</p>}<div className="service-list">{project.services.length ? project.services.map(service => <ServiceRow onOpenApi={url => { setApiTarget({ projectId: project.id, url }); setView('api'); }} key={service.id} service={service} running={running.includes(serviceKey(project.id, service.id))} {...servicePresentation(project, service)} busy={busy || stoppingKeys.current.has(serviceKey(project.id, service.id))} starting={startingKeys.current.has(serviceKey(project.id, service.id))} progress={bulkProgress[serviceKey(project.id, service.id)]} onEdit={(field, value) => editService(service.id, field, value)} onStart={() => void start(project, service)} onStop={() => requestStop(project, [service])} onRestart={() => restart(project, service)} onRemove={() => removeService(service)} />) : <EmptyState icon={<Terminal size={23} />} title="No services detected" description="Add a discovered service or create a manual configuration." action={<Button disabled={discoveringServices} onClick={() => void addService()}>Add service</Button>} />}</div><div className="inline-logs"><div className="section-heading"><div><span className="eyebrow">LATEST OUTPUT</span><h2>Activity</h2></div><Button tone="quiet" onClick={() => setView('logs')}>Open logs <ArrowRight size={15} /></Button></div><div className="activity-preview">{logs.filter(line => line.projectId === selected || (line.incidentId && !line.projectId)).slice(-3).map((line, index) => <div key={index}><span>{line.serviceId}</span><code>{line.message}</code></div>)}{!logs.some(line => line.projectId === selected) && <p>No output yet. Start a service to see its activity.</p>}</div></div></> : <EmptyState icon={<FolderPlus size={26} />} title="No project selected" description="Import a project folder to detect services, or select a saved project from the sidebar." action={<Button tone="primary" onClick={() => void importProject()}>Import project</Button>} />}</>}
    <div className="logs-workspace" hidden={view !== 'logs'}><header className="console-page-header"><h1><Terminal size={19} />Logs</h1>{project && <Button onClick={() => void floatLogs(project).then(() => setError('')).catch(cause => setError(errorMessage(cause)))}>Float logs</Button>}{project && <><label className="console-project-picker"><span className="sr-only">Project</span><select value={selected} onChange={event => selectProject(event.target.value)}>{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><ProjectShortcuts project={project} onTerminal={path => openDirectory(path, 'terminal')} onFolder={path => openDirectory(path, 'folder')} onCopyPath={copyDirectoryPath} onAiCli={openInAiCli} /></>}</header>{project && serviceAlerts(project)}{project ? logWorkspace(project) : logWorkspace({ id: '', name: 'DevFlow', root: '', services: [] })}</div>
    {view === 'api' && <React.Suspense fallback={<div className="loading-state" role="status">Loading API Tester…</div>}><ApiTester running={running.filter(key => !stoppingKeys.current.has(key))} key={selected} project={project} projects={projects} selectProject={selectProject} initialUrl={apiTarget?.projectId === selected ? apiTarget.url : undefined} /></React.Suspense>}
    {view === 'ports' && <React.Suspense fallback={<div className="loading-state" role="status">Loading Port Manager…</div>}><PortManager project={project} projects={projects} selectProject={selectProject} /></React.Suspense>}
    {view === 'environment' && <React.Suspense fallback={<div className="loading-state" role="status">Loading Developer Environment…</div>}><DeveloperEnvironment onSummary={setEnvironmentSummary} project={project} projects={projects} selectProject={selectProject} /></React.Suspense>}
    {editorOpened && <div hidden={view !== 'editor'}><React.Suspense fallback={<div className="loading-state" role="status">Loading Quick Editor…</div>}><EditorWorkspace active={view === 'editor'} projects={projects} selected={project} onDock={() => setView('editor')} /></React.Suspense></div>}
    {view === 'settings' && <><header className="page-header"><div><span className="eyebrow">PREFERENCES</span><h1>Settings<span className="accent-period">.</span></h1><p>Make the workspace comfortable for the way you work.</p></div><Settings2 size={23} className="header-icon" /></header><Card className="settings-card"><div className="settings-heading"><span className="settings-symbol">Aa</span><div><h2>Appearance</h2><p>Theme preferences are saved on this device.</p></div></div><div className="setting-row"><div><strong>Color theme</strong><span>Choose a look, or follow Windows.</span></div><div className="segmented-control" role="group" aria-label="Color theme">{(['light', 'dark', 'system'] as Theme[]).map(option => <button key={option} className={theme === option ? 'is-active' : ''} aria-pressed={theme === option} onClick={() => setTheme(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}</div></div><div className="setting-row"><div><strong>Compact layout</strong><span>Fit more services and logs on screen.</span></div><label className="switch"><input type="checkbox" checked={compact} onChange={event => setCompact(event.target.checked)} /><span className="switch-track" /><span className="sr-only">Compact layout</span></label></div></Card><ChatStorageSettings /><EditorPreferences /><NotificationSettings store={notifications} /><KeyboardSettings /><Card className="settings-card"><h2>Help / User Guide</h2><p>Search the complete local manual, workflows, limitations and troubleshooting.</p><HelpLink section="getting-started" /></Card><Card className="settings-card about-card"><div className="settings-heading"><span className="settings-symbol"><Terminal size={21} /></span><div><h2>Local by design</h2><p>Projects are saved in DevFlow's local application config. Logs remain in this session.</p></div></div></Card></>}
  </>}</main>{confirm && <ConfirmDialog title={confirm.title} description={confirm.description} confirmText={confirm.confirmText} destructive={confirm.destructive} onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm.action; setConfirm(null); action(); }} />}{renaming && <RenameProjectDialog key={renaming.id} currentName={renaming.name} onSave={saveProjectName} onCancel={() => setRenaming(null)} />}{serviceCandidates && project && <AddServiceDialog candidates={serviceCandidates} projectRoot={project.root} onAdd={addSelectedService} onSuggest={suggestService} onCancel={() => setServiceCandidates(null)} />}{quickSearchOpen && <QuickSearchDialog projects={projects} onSelect={id => { selectProject(id); setView('projects'); setQuickSearchOpen(false); }} onCancel={() => setQuickSearchOpen(false)} />}</div></LogsContext.Provider></ProjectServicesContext.Provider>;
}

function FloatingShortcuts() {
  const [error, setError] = useState('');
  useShortcuts({ error: setError });
  return <OperationNotice message={error} dismiss={() => setError('')} />;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><HelpHost />{(floatingLogsProject || floatingEditor) && <FloatingShortcuts />}{!floatingLogsProject && <WindowCloseHandler />}{floatingLogsProject ? <RemoteProjectServices><FloatingLogs /></RemoteProjectServices> : floatingEditor ? <RemoteProjectServices><FloatingEditor /></RemoteProjectServices> : <App />}</React.StrictMode>);
