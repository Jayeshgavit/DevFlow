import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowRight, Check, ChevronDown, Clipboard, Code2, Copy, Cpu, Download, FolderClosed, FolderOpen, FolderPlus, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Moon, Pause, Pencil, Play, Plus, RotateCcw, Search, Settings2, ShieldCheck, Square, Sun, Terminal, Trash2, X } from 'lucide-react';
import type { HealthSnapshot, Project, RunOption, Service, ServiceHealthConfig, Theme, View } from './types';
import type { BulkResult } from './bulk-actions';
import { buildAiDebugPrompt, errorContext, logCopyGroups, type LogCopyKind, parseErrorLocation, findLoopbackUrls, formatEntry, groupLogs, parseHttp, redactForSharing, serviceGroup, summarizeGroups } from './log-utils';
import { openErrorLocation, verifyErrorLocation } from './log-actions';
import type { AnsiSpan, LogCategory, LogEntry, LogGroup } from './log-utils';
import { MAX_PROJECT_LOGS, MAX_SERVICE_LOGS, MAX_SESSION_LOGS } from './log-utils';
import { LogViewport } from './log-viewport';
import { useMenuDismissal } from './menu-dismissal';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'quiet' | 'danger'; icon?: React.ReactNode };
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ tone = 'secondary', icon, children, className = '', ...props }, ref) {
  return <button ref={ref} className={`button button-${tone} ${className}`} {...props}>{icon}{children}</button>;
});

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Status({ running, starting, stopping, outcome, error }: { running: boolean; starting?: boolean; stopping?: boolean; outcome?: 'failed' | 'exited'; error?: boolean }) {
  const state = starting || stopping ? 'running' : error || outcome === 'failed' ? 'error' : running ? 'running' : 'stopped';
  const label = starting ? 'Starting' : stopping ? 'Stopping' : error || outcome === 'failed' ? 'Failed' : running ? 'Running' : outcome === 'exited' ? 'Exited' : 'Stopped';
  return <span className={`status status-${state}`}><span className="status-dot" />{label}</span>;
}

const navigation: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} /> },
  { id: 'projects', label: 'Projects', icon: <FolderClosed size={18} /> },
  { id: 'logs', label: 'Logs', icon: <Terminal size={18} /> },
  { id: 'editor', label: 'Quick Editor', icon: <Code2 size={18} /> },
  { id: 'system', label: 'System Monitor', icon: <Cpu size={18} /> },
  { id: 'maintenance', label: 'Maintenance', icon: <ShieldCheck size={18} /> },
  { id: 'settings', label: 'Settings', icon: <Settings2 size={18} /> },
];

export function Sidebar({ view, setView, projects, selected, selectProject, runningCount, theme, setTheme, importProject }: {
  view: View; setView: (view: View) => void; projects: Project[]; selected: string; selectProject: (id: string) => void;
  runningCount: number; theme: Theme; setTheme: (theme: Theme) => void; importProject: () => void;
}) {
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('devflow-sidebar-collapsed') === 'true'; } catch { return false; } });
  return <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="Main navigation">
    <button className="sidebar-toggle" aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} title={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed} onClick={() => { setCollapsed(!collapsed); try { localStorage.setItem('devflow-sidebar-collapsed', String(!collapsed)); } catch { /* Optional preference. */ } }}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
    <div className="brand"><span className="brand-mark"><Activity size={21} strokeWidth={2.5} /></span><span className="brand-name">DevFlow<span className="brand-period">.</span></span><span className="brand-tag">BETA</span></div>
    <div className="sidebar-section-label">WORKSPACE</div>
    <nav className="nav-list" aria-label="Views">{navigation.map(item => <button key={item.id} aria-label={item.label} title={item.label} className={`nav-item ${view === item.id ? 'is-active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>{item.icon}<span>{item.label}</span>{item.id === 'logs' && runningCount > 0 && <span className="nav-count">{runningCount}</span>}</button>)}</nav>
    <div className="sidebar-divider" />
    <div className="sidebar-section-label sidebar-project-label"><span>YOUR PROJECTS</span><span>{projects.length}</span></div>
    <div className="sidebar-projects">{projects.length === 0 ? <p className="sidebar-empty">No projects yet</p> : projects.map(project => <button key={project.id} aria-label={project.name} title={project.name} className={`sidebar-project ${selected === project.id && view === 'projects' ? 'is-selected' : ''}`} onClick={() => { selectProject(project.id); setView('projects'); }}><span className="project-initial">{project.name.slice(0, 1).toUpperCase()}</span><span className="sidebar-project-name">{project.name}</span><span className="sidebar-project-count">{project.services.length}</span></button>)}</div>
    <Button aria-label="Add project" title="Add project" className="sidebar-import" tone="quiet" icon={<Plus size={16} />} onClick={importProject}>Add project</Button>
    <div className="sidebar-bottom"><button className="theme-shortcut" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'system' ? 'System theme' : `${theme[0].toUpperCase()}${theme.slice(1)} theme`}</span></button><div className="local-note"><span className="local-dot" /> Local workspace</div></div>
  </aside>;
}

export function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

export function QuickSearchDialog({ projects, onSelect, onCancel }: {
  projects: Project[];
  onSelect: (projectId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onCancel]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = projects.flatMap(project => {
    const projectMatches = !normalizedQuery || `${project.name} ${project.root}`.toLocaleLowerCase().includes(normalizedQuery);
    const services = project.services.filter(service => !normalizedQuery || `${service.name} ${service.id} ${service.cwd}`.toLocaleLowerCase().includes(normalizedQuery));
    return projectMatches ? [{ project, serviceName: '' }] : services.map(service => ({ project, serviceName: service.name }));
  });
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={dialogRef} className="dialog quick-search-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-search-title">
      <button className="dialog-close icon-button" aria-label="Close quick search" onClick={onCancel}><X size={18} /></button>
      <div className="dialog-symbol"><Search size={22} /></div>
      <h2 id="quick-search-title">Find a project or service</h2>
      <p>Choose a result to open its project workspace. Nothing is started or changed.</p>
      <label className="quick-search-input"><Search size={16} /><span className="sr-only">Search projects and services</span><input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Project, service, or path" /></label>
      <div className="quick-search-results" role="listbox" aria-label="Project and service results">
        {matches.length ? matches.map(({ project, serviceName }) => <button key={`${project.id}:${serviceName}`} type="button" role="option" className="quick-search-result" onClick={() => onSelect(project.id)}><span><strong>{serviceName || project.name}</strong><small>{serviceName ? `${project.name} · service` : project.root}</small></span><ArrowRight size={15} /></button>) : <p className="quick-search-empty">No matching project or service.</p>}
      </div>
    </div>
  </div>;
}

export function FloatingMenu({ label, icon, triggerClassName = 'button button-secondary', align = 'start', panelRole = 'menu', autoClose = true, beforeOpen, children }: {
  label: string; icon: React.ReactNode; triggerClassName?: string; align?: 'start' | 'end'; panelRole?: 'menu' | 'dialog'; autoClose?: boolean; beforeOpen?: () => void; children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, left: 8, maxHeight: window.innerHeight - 16 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const finish = () => { close(); trigger.current?.focus({ preventScroll: true }); };
  useMenuDismissal(open, close, [trigger, panel], trigger);
  useLayoutEffect(() => { if (open && trigger.current?.closest('[hidden]')) setOpen(false); });
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const update = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const gap = 6;
      const below = Math.max(0, window.innerHeight - anchor.bottom - gap - 8);
      const above = Math.max(0, anchor.top - gap - 8);
      const placeBelow = bounds.height <= below || below >= above;
      const maxHeight = Math.max(100, Math.min(window.innerHeight - 16, placeBelow ? below : above));
      const top = placeBelow ? anchor.bottom + gap : anchor.top - Math.min(bounds.height, maxHeight) - gap;
      const left = align === 'end' ? anchor.right - bounds.width : anchor.left;
      setPosition({ top: Math.max(8, top), left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)), maxHeight });
    };
    update();
    panel.current.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (panel.current?.contains(document.activeElement) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) {
        const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
        event.preventDefault(); controls[next]?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, align]);
  return <div className="floating-menu-anchor"><button ref={trigger} type="button" className={triggerClassName} aria-haspopup={panelRole} aria-expanded={open} onPointerDown={() => { if (!open) beforeOpen?.(); }} onClick={event => { if (!open && event.detail === 0) beforeOpen?.(); setOpen(value => !value); }}>{icon}{label}<ChevronDown size={13} /></button>{open && createPortal(<div ref={panel} className="floating-menu-panel" role={panelRole} aria-label={label} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }} onClickCapture={event => {
    if (!autoClose || panelRole !== 'menu' || !(event.target instanceof Element)) return;
    const item = event.target.closest<HTMLButtonElement>('button[role="menuitem"]');
    if (item && !item.disabled) { close(); trigger.current?.focus({ preventScroll: true }); }
  }}>{children(finish)}</div>, document.body)}</div>;
}

export function ProjectShortcuts({ project, onTerminal, onFolder, onCopyPath, onAiCli }: {
  project: Project; onTerminal: (path: string) => Promise<void>; onFolder: (path: string) => Promise<void>; onCopyPath: (path: string) => Promise<boolean>;
  onAiCli: (path: string, cli: 'codex' | 'claude') => Promise<void>;
}) {
  const [copied, setCopied] = useState('');
  const destinations = [{ id: 'root', name: 'Project root', path: project.root }, ...project.services.map(service => ({ id: service.id, name: service.name, path: service.cwd }))];
  const menu = (kind: 'terminal' | 'folder' | 'copy') => {
    const isTerminal = kind === 'terminal';
    const isFolder = kind === 'folder';
    const title = isTerminal ? 'Open Terminal' : isFolder ? 'Open Folder' : 'Copy path';
    const icon = isTerminal ? <Terminal size={15} /> : isFolder ? <FolderOpen size={15} /> : <Clipboard size={15} />;
    return <FloatingMenu key={kind} label={title} icon={icon}>{close => destinations.map(destination => <button key={destination.id} role="menuitem" title={destination.path} onClick={() => {
        close();
        if (isTerminal) void onTerminal(destination.path);
        else if (isFolder) void onFolder(destination.path);
        else void onCopyPath(destination.path).then(success => { if (success) { setCopied(destination.id); window.setTimeout(() => setCopied(''), 1400); } });
      }}>{isFolder ? <FolderOpen size={14} /> : null}<span>{destination.name}</span>{kind === 'copy' && (copied === destination.id ? <Check size={14} /> : <Copy size={13} />)}</button>)}</FloatingMenu>;
  };
  const aiMenu = (cli: 'codex' | 'claude') => {
    const label = cli === 'codex' ? 'Open in Codex' : 'Open in Claude';
    return (
      <FloatingMenu key={cli} label={label} icon={<Cpu size={15} />}>
        {close => destinations.map(destination => (
          <button key={destination.id} role="menuitem" title={destination.path} onClick={() => { close(); void onAiCli(destination.path, cli); }}>
            <Terminal size={14} /><span>{destination.name}</span>
          </button>
        ))}
      </FloatingMenu>
    );
  };
  return <div className="directory-shortcuts" aria-label="Project shortcuts">{menu('terminal')}{menu('folder')}{menu('copy')}{aiMenu('codex')}{aiMenu('claude')}</div>;
}

const serviceFrameworks = ['Next.js', 'Vite/React', 'Node.js', 'Rust/Cargo', 'FastAPI', 'Flask', 'Django', 'Custom'] as const;
type EditableServiceField = 'name' | 'cwd' | 'program' | 'args' | 'role' | 'framework' | 'host' | 'port' | 'entryPoint';

function ServiceRowBase({ service, running, starting = false, stopping = false, progress, outcome, issue, busy, suggestion, onEdit, onFrameworkChange, onApplySuggestion, onSelectOption, onReset, onStart, onStop, onRestart, onRemove }: {
  service: Service; running: boolean; starting?: boolean; stopping?: boolean; progress?: BulkResult; outcome?: 'failed' | 'exited'; issue?: string; busy: boolean; onEdit: (field: EditableServiceField, value: string) => void;
  suggestion?: Service; onFrameworkChange: (framework: string) => void; onApplySuggestion: (suggestion: Service) => void; onSelectOption: (option: RunOption) => void; onReset: () => void; onStart: () => void; onStop: () => void; onRestart: () => void; onRemove: () => void;
}) {
  const options = service.runOptions || [];
  const selectedOption = options.find(option => option.program === service.program && option.args.join('\n') === service.args.join('\n'))?.id || 'custom';
  const selectedRunOption = options.find(option => option.id === selectedOption);
  const source = service.reviewNote?.startsWith('Manual service') || service.reviewNote?.includes('Manual override') ? 'Manual' : service.reviewNote ? 'Suggested' : service.framework ? 'Detected' : 'Manual';
  const readiness = service.program.trim() && service.args.length && (!selectedRunOption || selectedRunOption.verified) ? 'Ready to run' : 'Needs review';
  const locked = running || starting || stopping || busy;
  return <Card className="service-card"><div className="service-header"><span className="service-icon"><Terminal size={18} /></span><div className="service-identity"><input className="service-name" aria-label={`Name for ${service.name}`} value={service.name} onChange={e => onEdit('name', e.target.value)} disabled={locked} /><span className="service-caption">{source} · {service.role || 'other'} · {service.framework || 'Custom'} · {readiness}{service.confidence ? ` · ${service.confidence} confidence` : ''}</span></div><Status running={running} starting={starting} stopping={stopping} outcome={outcome} error={Boolean(issue) && !running} /><div className="service-actions"><Button tone="quiet" aria-label={`Restart ${service.name}`} title="Restart" disabled={!running || starting || stopping || busy} onClick={onRestart} icon={<RotateCcw size={16} />} /><Button tone="quiet" aria-label={`${running || starting || stopping ? 'Stop' : 'Start'} ${service.name}`} title={stopping ? 'Stopping' : running || starting ? 'Stop' : 'Start'} disabled={stopping || (!running && !starting && busy)} onClick={running || starting || stopping ? onStop : onStart} icon={running || starting || stopping ? <Square size={16} /> : <Play size={16} />} /><Button tone="quiet" aria-label={`Remove ${service.name}`} title={`Remove ${service.name}`} disabled={running || starting || stopping || busy} onClick={onRemove} icon={<Trash2 size={16} />} /></div></div>{progress && <p className={`service-progress service-progress-${progress.step}`} role="status">{progress.detail}</p>}{issue && <p className="service-issue" role="alert">{issue}</p>}{service.reviewNote && <p className="service-review-note">{service.reviewNote}</p>}{(service.interpreterPath || service.entryPoint) && <p className="service-detection-note">{service.interpreterPath && <>Interpreter: <code>{friendlyWindowsPath(service.interpreterPath)}</code></>}{service.entryPoint && <> · ASGI target: <code>{service.entryPoint}</code></>}</p>}<div className="service-fields"><label>ROLE<select disabled={locked} value={service.role || 'other'} onChange={e => onEdit('role', e.target.value)}><option value="frontend">Frontend</option><option value="backend">Backend</option><option value="other">Other</option></select></label><label>FRAMEWORK<select disabled={locked} value={service.framework || 'Custom'} onChange={e => onFrameworkChange(e.target.value)}>{service.framework && !serviceFrameworks.includes(service.framework as typeof serviceFrameworks[number]) && <option>{service.framework}</option>}{serviceFrameworks.map(framework => <option key={framework}>{framework}</option>)}</select></label><label>RUN COMMAND<select disabled={locked} value={selectedOption} onChange={event => { const option = options.find(item => item.id === event.target.value); if (option) onSelectOption(option); }}><option value="custom">Custom / edit fields</option>{options.map((option, index) => <option key={option.id} value={option.id}>{index === 0 ? 'Recommended · ' : 'Detected · '}{option.label}{option.verified ? ' · verified' : ' · needs review'}</option>)}</select></label><label>HOST <span className="label-hint">DEFAULT 127.0.0.1</span><input disabled={locked} value={service.host ?? ''} placeholder="127.0.0.1" onChange={e => onEdit('host', e.target.value)} spellCheck={false} /></label><label>PORT <span className="label-hint">OPTIONAL / DEFAULT 8000</span><input disabled={locked} type="number" min="1" max="65535" value={service.port ?? ''} onChange={e => onEdit('port', e.target.value)} /></label><label>WORKING DIRECTORY<input disabled={locked} value={service.cwd} onChange={e => onEdit('cwd', e.target.value)} spellCheck={false} /></label><label>EXECUTABLE<input id={`service-command-${service.id}`} disabled={locked} value={service.program} onChange={e => onEdit('program', e.target.value)} spellCheck={false} /></label>{service.framework === 'FastAPI' && <label>ASGI TARGET <span className="label-hint">MODULE:VARIABLE</span><input disabled={locked} value={service.entryPoint || ''} placeholder="app.main:app" onChange={e => onEdit('entryPoint', e.target.value)} spellCheck={false} /></label>}<label>ARGUMENTS <span className="label-hint">ONE PER LINE</span><textarea disabled={locked} rows={Math.max(2, Math.min(8, service.args.length))} value={service.args.join('\n')} onChange={e => onEdit('args', e.target.value)} spellCheck={false} /></label></div>{options.find(option => option.id === selectedOption)?.explanation && <p className="service-detection-note">{options.find(option => option.id === selectedOption)?.explanation}</p>}<p className="service-detection-note">For Python: <code>-m</code> runs a module, <code>uvicorn</code> runs an ASGI app, <code>main:app</code> means module <code>main</code> and variable <code>app</code>; <code>--reload</code> enables development reload, while <code>--host</code>/<code>--port</code> set the listening address.</p>{suggestion && <div className="service-command-actions"><span>Verified suggestion available for {suggestion.framework || service.framework}.</span><Button tone="quiet" disabled={locked} onClick={() => onApplySuggestion(suggestion)}>Apply suggested command</Button></div>}<div className="service-command-actions"><span>Reset restores the latest valid recommendation after confirmation.</span><Button tone="quiet" disabled={locked} onClick={onReset}>Reset commands</Button></div></Card>;
}

type ServiceRowBaseProps = React.ComponentProps<typeof ServiceRowBase>;
export function ServiceRow(props: ServiceRowBaseProps & { health?: HealthSnapshot; healthConfig?: ServiceHealthConfig; onHealthChange?: (changes: Partial<ServiceHealthConfig>) => void; onCheckNow?: () => void }) {
  const { health, healthConfig, onHealthChange, onCheckNow, service, running, starting = false, stopping = false, busy = false } = props;
  return <><ServiceRowBase {...props} /><ServiceHealthPanel service={service} running={running} locked={busy || starting || stopping} config={healthConfig || { enabled: false, host: service.host || '127.0.0.1', port: service.port, path: '/', intervalSeconds: 10, timeoutSeconds: 2, expectedStatusMin: 200, expectedStatusMax: 399 }} health={health} onChange={onHealthChange || (() => {})} onCheckNow={onCheckNow || (() => {})} /></>;
}

type CategoryFilter = 'all' | LogCategory | 'http';

export function ServiceHealthPanel({ service, running, locked, config, health, onChange, onCheckNow }: {
  service: Service; running: boolean; locked: boolean; config: ServiceHealthConfig; health?: HealthSnapshot;
  onChange: (changes: Partial<ServiceHealthConfig>) => void; onCheckNow: () => void;
}) {
  const status = !running ? (service.role === 'other' && !config.port && !service.port ? 'notApplicable' : 'unknown') : health?.status || (config.enabled ? 'checking' : 'disabled');
  const statusLabel = status === 'healthy' ? 'Healthy' : status === 'unhealthy' ? 'Unhealthy' : status === 'checking' ? 'Checking' : status === 'unknown' ? 'Unknown' : status === 'notApplicable' ? 'Not applicable' : 'Health check disabled';
  const detail = !running ? (status === 'notApplicable' ? 'No HTTP endpoint configured' : 'Service is not running') : health?.statusCode ? `${health.statusCode}${health.responseMs === undefined ? '' : ` · ${health.responseMs} ms`}` : health?.error || (status === 'checking' ? 'Waiting for a response' : status === 'disabled' ? 'Opt in to HTTP monitoring' : 'No HTTP result yet');
  const checkedAt = health?.checkedAt ? ` · Checked ${new Date(health.checkedAt).toLocaleTimeString()}` : '';
  return <div className="service-health-panel"><div className="service-health-panel__summary"><span className={`service-health-panel__status service-health-panel__status--${status}`}><i aria-hidden="true" />{statusLabel}</span><span>{detail}{checkedAt}</span><Button tone="quiet" disabled={locked || !running || !config.enabled} onClick={onCheckNow}>Check now</Button></div><details><summary>HTTP health check configuration</summary><div className="service-health-panel__fields"><label><span>Monitor HTTP</span><input type="checkbox" checked={config.enabled} disabled={locked} onChange={event => onChange({ enabled: event.target.checked })} /></label><label>HOST<input value={config.host} disabled={locked} onChange={event => onChange({ host: event.target.value })} spellCheck={false} /></label><label>PORT<input type="number" min="1" max="65535" value={config.port ?? ''} disabled={locked} onChange={event => onChange({ port: event.target.value ? Number(event.target.value) : undefined })} /></label><label>PATH<input value={config.path} disabled={locked} onChange={event => onChange({ path: event.target.value })} spellCheck={false} /></label><label>INTERVAL <span className="label-hint">SECONDS</span><input type="number" min="1" max="3600" value={config.intervalSeconds} disabled={locked} onChange={event => onChange({ intervalSeconds: Number(event.target.value) || 10 })} /></label><label>TIMEOUT <span className="label-hint">SECONDS</span><input type="number" min="1" max="30" value={config.timeoutSeconds} disabled={locked} onChange={event => onChange({ timeoutSeconds: Number(event.target.value) || 2 })} /></label><label>EXPECTED STATUS MIN<input type="number" min="100" max="599" value={config.expectedStatusMin} disabled={locked} onChange={event => onChange({ expectedStatusMin: Number(event.target.value) || 200 })} /></label><label>EXPECTED STATUS MAX<input type="number" min="100" max="599" value={config.expectedStatusMax} disabled={locked} onChange={event => onChange({ expectedStatusMax: Number(event.target.value) || 399 })} /></label></div><p className="service-detection-note">Only loopback HTTP endpoints are checked. Health failures never stop or restart the process.</p></details></div>;
}

const MessageText = React.memo(function MessageText({ message, ansiSpans = [], slowMs, onOpenUrl }: { message: string; ansiSpans?: AnsiSpan[]; slowMs: number; onOpenUrl: (url: string) => void }) {
  const http = useMemo(() => parseHttp(message), [message]);
  const semanticSpans = useMemo(() => {
    if (http) return http.spans;
    // Render plain React text and spans; output is never interpreted as markup.
    const matches = message.matchAll(/\b(?:[\w.]+(?:Error|Exception)|ERROR|FATAL|WARN(?:ING)?)\b|(?:[A-Za-z]:\\|\.{0,2}\/)[\w.@/\\-]+(?::\d+(?::\d+)?)?|\b[\w.-]+\.(?:tsx?|jsx?|py|rs|go|java):\d+(?::\d+)?/g);
    return Array.from(matches, match => ({ start: match.index!, end: match.index! + match[0].length, kind: /[\\/]|:\d/.test(match[0]) ? 'path' : 'diagnostic' }));
  }, [message, http]);
  const urls = useMemo(() => findLoopbackUrls(message), [message]);
  const boundaries = new Set([0, message.length]);
  semanticSpans.forEach(span => { boundaries.add(span.start); boundaries.add(span.end); });
  ansiSpans.forEach(span => { boundaries.add(span.start); boundaries.add(span.end); });
  urls.forEach(url => { boundaries.add(url.start); boundaries.add(url.end); });
  const ordered = [...boundaries].sort((left, right) => left - right);
  const pieces: React.ReactNode[] = [];
  ordered.slice(0, -1).forEach((start, index) => {
    const end = ordered[index + 1];
    if (end <= start) return;
    const semantic = semanticSpans.find(span => span.start <= start && span.end >= end);
    const ansi = ansiSpans.find(span => span.start <= start && span.end >= end);
    const url = urls.find(candidate => candidate.start <= start && candidate.end >= end);
    const slow = semantic?.kind === 'duration' && (http?.durationMs ?? 0) >= slowMs;
    const className = [semantic && `log-token log-token-${semantic.kind}`, slow && 'is-slow', ansi?.style.bold && 'ansi-bold', ansi?.style.foreground && `ansi-fg-${ansi.style.foreground}`, ansi?.style.background && `ansi-bg-${ansi.style.background}`, url && 'log-local-link'].filter(Boolean).join(' ');
    const content = message.slice(start, end);
    const title = slow ? `Slow request: ${http?.durationMs} ms (threshold ${slowMs} ms)` : undefined;
    pieces.push(url ? <a key={start} className={className} href={url.url} title={`Open ${url.url} in your browser`} onClick={event => { event.preventDefault(); onOpenUrl(url.url); }}>{content}</a> : <span key={start} className={className || undefined} title={title}>{content}</span>);
  });
  return <>{pieces}</>;
});

function combineLogText(entries: LogEntry[]) {
  let message = '';
  const ansiSpans: AnsiSpan[] = [];
  entries.forEach((entry, index) => {
    if (index) message += '\n';
    const offset = message.length;
    message += entry.message;
    entry.ansiSpans?.forEach(span => ansiSpans.push({ ...span, start: span.start + offset, end: span.end + offset }));
  });
  return { message, ansiSpans };
}

const logRowIds = new WeakMap<LogEntry, number>();
const logTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
let nextLogRowId = 0;
function logRowId(entry: LogEntry) {
  if (!logRowIds.has(entry)) logRowIds.set(entry, ++nextLogRowId);
  return `log-entry-${logRowIds.get(entry)}`;
}

function ErrorEditorAction({ project, message }: { project: Project; message: string }) {
  const location = useMemo(() => parseErrorLocation(message, project.root), [message, project.root]);
  const [verified, setVerified] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; setVerified(false); setError('');
    if (location) void verifyErrorLocation(project, location).then(valid => { if (!disposed) setVerified(valid); }).catch(() => {});
    return () => { disposed = true; };
  }, [project.id, project.root, location]);
  return <>{verified && <button title={`Open in Quick Editor: ${location!.path}:${location!.line}`} aria-label="Open in Quick Editor" onClick={() => { void openErrorLocation(project, location!).then(() => setError('')).catch(cause => setError(String(cause))); }}><Code2 size={14} /></button>}{error && <span role="alert">{error}</span>}</>;
}

export function LogViewer({ focusIncident, project, logs, filter, setFilter, search, setSearch, searchRef, autoScroll, setAutoScroll, onCopy, onExport, onClear, onOpenUrl, actionMessage, serviceControls }: {
  focusIncident?: { incidentId: string; request: number };
  project: Project; logs: LogEntry[]; filter: string; setFilter: (value: string) => void; search: string; setSearch: (value: string) => void;
  searchRef?: React.RefObject<HTMLInputElement>;
  serviceControls?: React.ReactNode;
  autoScroll: boolean; setAutoScroll: (value: boolean) => void; onCopy: (text: string, message: string) => Promise<boolean>; onExport: (text: string) => Promise<boolean>; onClear: (entries: LogEntry[]) => void; onOpenUrl: (url: string) => void; actionMessage: string;
}) {
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [slowMs, setSlowMs] = useState(1000);
  const [copiedRow, setCopiedRow] = useState('');
  const [streamFilter, setStreamFilter] = useState('all');
  const [activeIssue, setActiveIssue] = useState<LogEntry | null>(null);
  const [issueRequest, setIssueRequest] = useState(0);
  const [visibleGroups, setVisibleGroups] = useState<LogGroup[]>([]);
  const [selectedRows, setSelectedRows] = useState(new Set<LogEntry>());
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; confirmText: string; action: () => void; destructive?: boolean }>();
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const [selectionSnapshot, setSelectionSnapshot] = useState('');
  const [showTime, setShowTime] = useState(() => { try { return localStorage.getItem('devflow-log-time') !== 'false'; } catch { return true; } });
  const [showService, setShowService] = useState(() => { try { return localStorage.getItem('devflow-log-service') !== 'false'; } catch { return true; } });
  const localSearchRef = useRef<HTMLInputElement>(null);
  const inputRef = searchRef || localSearchRef;
  const resetFilters = () => { setFilter('all'); setSearch(''); setCategoryFilter('all'); setStreamFilter('all'); setActiveIssue(null); setSelectedRows(new Set()); setSelection(''); setSelectionSnapshot(''); };
  const complete = async (action: () => Promise<boolean>, close?: () => void) => {
    if (actionLock.current) return;
    actionLock.current = true; setActionBusy(true);
    try { if (await action()) close?.(); } finally { actionLock.current = false; setActionBusy(false); }
  };

  const [fontSize, setFontSize] = useState(() => {
    try { const value = Number(localStorage.getItem('devflow-log-font-size') || 12); return Number.isFinite(value) ? Math.min(22, Math.max(10, value)) : 12; } catch { return 12; }
  });
  const [wrap, setWrap] = useState(() => { try { return localStorage.getItem('devflow-log-wrap') !== 'false'; } catch { return true; } });
  const [selection, setSelection] = useState('');
  const consoleRef = useRef<HTMLDivElement>(null);
  const expandedStacks = useRef(new WeakSet<LogEntry>());
  const [, setStackRevision] = useState(0);
  useEffect(() => {
    try { localStorage.setItem('devflow-log-font-size', String(fontSize)); localStorage.setItem('devflow-log-wrap', String(wrap)); } catch { /* preferences remain in memory */ }
  }, [fontSize, wrap]);
  useEffect(() => { try { localStorage.setItem('devflow-log-time', String(showTime)); localStorage.setItem('devflow-log-service', String(showService)); } catch {} }, [showTime, showService]);
  useEffect(() => {
    const retained = new Set(logs);
    setSelectedRows(current => new Set([...current].filter(entry => retained.has(entry))));
  }, [logs]);
  useEffect(() => { setActiveIssue(null); setSelection(''); setSelectionSnapshot(''); setVisibleGroups([]); setSelectedRows(new Set()); }, [project.id, filter, search, categoryFilter, streamFilter]);
  useEffect(() => {
    const capture = () => {
      const selected = window.getSelection();
      if (selected?.rangeCount && !selected.isCollapsed && consoleRef.current?.contains(selected.anchorNode) && consoleRef.current.contains(selected.focusNode)) {
        const range = selected.getRangeAt(0);
        const sources = [...consoleRef.current.querySelectorAll<HTMLElement>('[data-log-source]')].filter(row => range.intersectsNode(row)).map(row => row.dataset.logSource);
        setSelection(`${sources.join('\n')}\n\n${selected.toString()}`);
      } else setSelection('');
    };
    document.addEventListener('selectionchange', capture);
    return () => document.removeEventListener('selectionchange', capture);
  }, []);
  const deferredSearch = useDeferredValue(search);
  const handledIncidentRequest = useRef<number>();
  useEffect(() => {
    if (!focusIncident || handledIncidentRequest.current === focusIncident.request || deferredSearch) return;
    handledIncidentRequest.current = focusIncident.request;
    setCategoryFilter('all'); setStreamFilter('all');
    // Wait for deferred search to clear before asking the viewport to focus a row.
    const entry = [...logs].reverse().find(line => line.incidentId === focusIncident.incidentId);
    setActiveIssue(entry || null);
  }, [focusIncident, deferredSearch]);
  const projectEntries = useMemo(() => logs.filter(entry => entry.projectId === project.id || (!entry.projectId && !!entry.incidentId)), [logs, project.id]);
  const groups = useMemo(() => groupLogs(projectEntries), [projectEntries]);
  const serviceNames = useMemo(() => new Map(project.services.map(service => [service.id, service.name])), [project.services]);
  const serviceScoped = useMemo(() => groups.filter(group => (filter === 'all' || group.entries[0].serviceId === filter || (filter.startsWith('role:') && project.services.some(service => service.id === group.entries[0].serviceId && serviceGroup(service) === filter.slice(5)))) && (streamFilter === 'all' || group.entries[0].stream === streamFilter)), [groups, filter, streamFilter, project.services]);
  const searched = useMemo(() => {
    const query = deferredSearch.trim().toLocaleLowerCase();
    return serviceScoped.filter(group => !query || group.searchText.includes(query) || (serviceNames.get(group.entries[0].serviceId) || '').toLocaleLowerCase().includes(query));
  }, [serviceScoped, deferredSearch, serviceNames]);
  const filtered = useMemo(() => {
    return searched.filter(group => {
      if (categoryFilter === 'http' && !group.http) return false;
      if (categoryFilter !== 'all' && categoryFilter !== 'http' && group.category !== categoryFilter) return false;
      return true;
    });
  }, [searched, categoryFilter]);
  const stats = useMemo(() => summarizeGroups(filtered), [filtered]);
  const categoryStats = useMemo(() => summarizeGroups(searched), [searched]);
  const navigateIssue = (category: 'error' | 'warning', direction: number) => {
    const indices = filtered.flatMap((group, index) => group.category === category ? [index] : []);
    if (!indices.length) return;
    const current = filtered.findIndex(group => group.entries[0] === activeIssue);
    const target = direction > 0 ? indices.find(index => index > current) ?? indices[0] : [...indices].reverse().find(index => index < (current < 0 ? filtered.length : current)) ?? indices[indices.length - 1];
    const entry = filtered[target].entries[0];
    setAutoScroll(false);
    setActiveIssue(entry);
    setIssueRequest(value => value + 1);
  };

  const formatGroups = (selection: LogGroup[]) => selection.flatMap(group => group.entries.map(entry => redactForSharing(formatEntry(entry, serviceNames.get(entry.serviceId) || entry.serviceId)))).join('\n');
  const copy = (selection: LogGroup[], label: string, includeContext = false) => {
    const entries = selection.flatMap(group => group.entries);
    if (!entries.length) return Promise.resolve(false);
    return onCopy(includeContext ? formatEntries(errorContext(projectEntries, entries)) + '\n[Context limited to 200 buffered lines]' : formatGroups(selection), label);
  };
  const copyPrompt = () => {
    const errors = filtered.filter(group => group.category === 'error');
    const relevant = errors.length ? errors : filtered;
    const prompt = buildAiDebugPrompt(project, project.services, errorContext(projectEntries, relevant.flatMap(group => group.entries))) + '\n[Context limited to 200 buffered lines]';
    return onCopy(prompt, 'AI debug prompt copied');
  };
  const selectionFor = (kind: LogCopyKind) => logCopyGroups(project, groups, filtered, kind);
  const filteredEntries = useMemo(() => filtered.flatMap(group => group.entries), [filtered]);
  const formatEntries = (entries: LogEntry[]) => entries.map(entry => redactForSharing(formatEntry(entry, serviceNames.get(entry.serviceId) || entry.serviceId))).join('\n');
  const checkedEntries = filteredEntries.filter(entry => selectedRows.has(entry));
  const serviceEntries = serviceScoped.flatMap(group => group.entries);
  const viewportGroups = visibleGroups.filter(group => filtered.includes(group));
  const viewportErrors = viewportGroups.filter(group => group.category === 'error');
  const viewportWarnings = viewportGroups.filter(group => group.category === 'warning');
  const visibleErrors = useMemo(() => filtered.filter(group => group.category === 'error'), [filtered]);
  const visibleWarnings = useMemo(() => filtered.filter(group => group.category === 'warning'), [filtered]);
  const renderGroup = (group: LogGroup) => {
    const first = group.entries[0];
    const expanded = expandedStacks.current.has(first);
    const shown = group.repeatCount > 1 ? [...group.sample, ...group.entries.slice(-group.sample.length)] : group.entries;
    const text = combineLogText(group.entries.length > 1 && !expanded ? [first] : shown);
    const copyId = logRowId(first);
    const groupDetails = group.http;
    const statusKind = groupDetails ? groupDetails.status < 300 ? 'success' : groupDetails.status < 400 ? 'redirect' : groupDetails.status < 500 ? 'client-error' : 'server-error' : '';
    return <div key={copyId} id={copyId} data-log-source={`[${new Date(first.receivedAt).toLocaleString()}] [${serviceNames.get(first.serviceId) || first.serviceId}] [${first.stream}]`} tabIndex={-1} className={`log-row log-category-${group.category}${activeIssue === first ? ' is-targeted' : ''}${group.entries.length > 1 ? ' is-grouped' : ''}${groupDetails && groupDetails.status >= 400 && groupDetails.status < 500 ? ' is-http-client' : ''}`}>
      <time hidden={!showTime} className="log-row-time" dateTime={new Date(first.receivedAt).toISOString()} title={new Date(first.receivedAt).toLocaleString()}>{logTime.format(first.receivedAt)}</time>
      <span hidden={!showService} className="log-service" title={serviceNames.get(first.serviceId) || first.serviceId}>{serviceNames.get(first.serviceId) || first.serviceId}</span>
      <span className={`log-stream stream-${first.stream}`}>{first.incidentId ? 'DevFlow' : first.stream}</span>
      <div className="log-row-content"><input className="log-select-row" type="checkbox" aria-label={`Select log entry from ${serviceNames.get(first.serviceId) || first.serviceId} at ${logTime.format(first.receivedAt)}`} checked={group.entries.every(entry => selectedRows.has(entry))} onChange={event => { const checked = event.target.checked; setSelectedRows(current => { const next = new Set(current); group.entries.forEach(entry => checked ? next.add(entry) : next.delete(entry)); return next; }); }} />{group.repeatCount > 1 && <span className="log-repeat-summary" title={`First: ${new Date(first.receivedAt).toLocaleString()} · Latest: ${new Date(group.latestAt).toLocaleString()}`}>Repeated {group.repeatCount.toLocaleString()} times · latest {logTime.format(group.latestAt)}</span>}
        {group.entries.length > 1 ? <details className="log-stack-details" open={expanded} onToggle={event => { const next = event.currentTarget.open; if (next === expandedStacks.current.has(first)) return; if (next) expandedStacks.current.add(first); else expandedStacks.current.delete(first); setStackRevision(value => value + 1); }}><summary><span className="log-level">{group.category}</span><MessageText message={first.message} ansiSpans={first.ansiSpans} slowMs={slowMs} onOpenUrl={onOpenUrl} /><span className="stack-line-count">{group.repeatCount > 1 ? `${group.repeatCount.toLocaleString()} repeats · first + latest sample` : `${group.entries.length} lines · expand stack`}</span></summary>{expanded && <pre className="log-message"><MessageText message={text.message} ansiSpans={text.ansiSpans} slowMs={slowMs} onOpenUrl={onOpenUrl} /></pre>}</details> : <div className="log-message"><span className="log-level">{group.category}</span><MessageText message={text.message} ansiSpans={text.ansiSpans} slowMs={slowMs} onOpenUrl={onOpenUrl} /></div>}
        {groupDetails && <div className="http-meta"><span className="http-method">{groupDetails.method}</span><span className="http-endpoint">{groupDetails.endpoint}</span><span className={`http-status is-${statusKind}`}>{groupDetails.status}</span>{groupDetails.durationMs !== undefined && <span className={`http-duration${groupDetails.durationMs >= slowMs ? ' is-slow' : ''}`}>{groupDetails.durationMs < 1000 ? `${Math.round(groupDetails.durationMs)} ms` : `${(groupDetails.durationMs / 1000).toFixed(2)} s`}{groupDetails.durationMs >= slowMs ? ' · slow' : ''}</span>}</div>}
      </div>
      <div className="log-row-actions"><button disabled={actionBusy} className={`log-copy-row${copiedRow === copyId ? ' is-copied' : ''}`} aria-label={`Copy ${group.category === 'error' ? 'error block' : 'log entry'} from ${serviceNames.get(first.serviceId) || first.serviceId}`} title={copiedRow === copyId ? 'Copied' : 'Copy log entry'} onClick={() => { void complete(async () => { const success = await copy([group], 'Log entry copied'); if (success) { setCopiedRow(copyId); window.setTimeout(() => setCopiedRow(''), 1300); } return success; }); }}>{copiedRow === copyId ? <Check size={14} /> : <Copy size={14} />}</button>{group.category === 'error' && <><button disabled={actionBusy} aria-label="Copy error with context" title="Copy error with nearby context (up to 200 lines)" onClick={() => void complete(() => copy([group], 'Error with context copied', true))}><Clipboard size={14} /></button><ErrorEditorAction project={project} message={group.sample.map(entry => entry.message).join('\n')} /></>}</div>
    </div>;
  };

  return <div className="logs-viewer-shell" onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); inputRef.current?.focus(); }
    if (event.key === 'F8') { event.preventDefault(); event.stopPropagation(); navigateIssue(event.altKey ? 'warning' : 'error', event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape' && event.target === inputRef.current && search) { event.preventDefault(); event.stopPropagation(); setSearch(''); }
  }}><Card className={`log-panel developer-console${showTime ? '' : ' hide-log-time'}${showService ? '' : ' hide-log-service'}`}>
    {serviceControls}
    <div className="console-toolbar" aria-label="Console controls">
      <label className="console-service"><span className="sr-only">Service log filter</span><select value={filter} onChange={event => { setAutoScroll(false); setActiveIssue(null); setFilter(event.target.value); }}><option value="all">Combined services</option><option value="role:frontend">Frontend</option><option value="role:backend">Backend</option>{project.services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
      <label className="search-field console-search"><Search size={15} /><span className="sr-only">Search logs</span><input ref={inputRef} value={search} onChange={event => { setAutoScroll(false); setActiveIssue(null); setSearch(event.target.value); }} placeholder="Search output…" aria-keyshortcuts="Control+f" /><kbd>Ctrl F</kbd></label>
      <Button tone="quiet" aria-label={autoScroll ? 'Pause following output' : 'Follow latest output'} aria-pressed={autoScroll} icon={autoScroll ? <Pause size={14} /> : <Play size={14} />} onClick={() => { setActiveIssue(null); setAutoScroll(!autoScroll); }}>{autoScroll ? 'Pause' : 'Follow'}</Button>
      <FloatingMenu label="Options" icon={<Settings2 size={15} />} triggerClassName="button button-quiet" align="end" panelRole="dialog">{close => <div className="console-options">
        <label>Font size <span>{fontSize}px</span><input aria-label="Log font size" type="range" min="10" max="22" step="1" value={fontSize} onChange={event => setFontSize(Number(event.target.value))} /></label>
        <label className="console-check"><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />Wrap lines</label>
        <label className="console-check"><input type="checkbox" checked={showTime} onChange={event => setShowTime(event.target.checked)} />Show timestamps</label>
        <label className="console-check"><input type="checkbox" checked={showService} onChange={event => setShowService(event.target.checked)} />Show service labels</label>
        <button onClick={() => { resetFilters(); close(); }}>Clear filters</button>
        <label>Stream<select value={streamFilter} onChange={event => { setAutoScroll(false); setActiveIssue(null); setStreamFilter(event.target.value); }}><option value="all">All streams</option><option value="stdout">stdout</option><option value="stderr">stderr</option><option value="system">system</option></select></label>
        <label>Slow request (ms)<input aria-label="Slow request threshold in milliseconds" type="number" min="0" max="600000" step="100" value={slowMs} onChange={event => setSlowMs(Math.min(600000, Math.max(0, Number(event.target.value) || 0)))} /></label>
      </div>}</FloatingMenu>
      <FloatingMenu label="Copy" icon={<Clipboard size={15} />} triggerClassName="button button-quiet" align="end" autoClose={false} beforeOpen={() => setSelectionSnapshot(selection)}>{close => <>
        <button role="menuitem" disabled={actionBusy || !selectionSnapshot} onClick={() => void complete(() => onCopy(redactForSharing(selectionSnapshot), 'Selection copied'), close)}>Copy selection</button>
        <button role="menuitem" disabled={actionBusy || !checkedEntries.length} onClick={() => void complete(() => onCopy(formatEntries(checkedEntries), 'Selected lines copied'), close)}>Copy selected lines<span>{checkedEntries.length}</span></button>
        <button role="menuitem" disabled={actionBusy || !viewportGroups.length} onClick={() => void complete(() => copy(viewportGroups, 'Visible output copied'), close)}>Copy visible output</button>
        {([['all', 'All combined logs'], ['frontend', 'Frontend logs'], ['backend', 'Backend logs'], ['errors', 'All errors'], ['frontend-errors', 'Frontend errors'], ['backend-errors', 'Backend errors'], ['current', 'Current filtered view']] as const).map(([kind, label]) => <button key={kind} role="menuitem" disabled={actionBusy || !selectionFor(kind).length} onClick={() => void complete(() => copy(selectionFor(kind), `${label} copied`), close)}>{label}<span>{selectionFor(kind).flatMap(group => group.entries).length}</span></button>)}
        <button role="menuitem" disabled={actionBusy || !viewportErrors.length} onClick={() => void complete(() => copy(viewportErrors, 'Visible errors copied'), close)}>Visible errors<span>{viewportErrors.flatMap(group => group.entries).length}</span></button>
        <button role="menuitem" disabled={actionBusy || !viewportWarnings.length} onClick={() => void complete(() => copy(viewportWarnings, 'Visible warnings copied'), close)}>Visible warnings<span>{viewportWarnings.flatMap(group => group.entries).length}</span></button>
        <button role="menuitem" disabled={actionBusy || !visibleErrors.length} onClick={() => void complete(() => copy(visibleErrors, 'Errors with context copied', true), close)}>Errors with nearby context<span>up to 200 lines</span></button>
        <button role="menuitem" disabled={actionBusy || !filtered.length} onClick={() => void complete(copyPrompt, close)}>Copy as AI Debug Prompt<span>best effort masking</span></button>
      </>}</FloatingMenu>
      <FloatingMenu label="More" icon={<ChevronDown size={15} />} triggerClassName="button button-quiet" align="end" autoClose={false}>{close => <>
        {[50, 100, 500].map(count => <button key={count} role="menuitem" disabled={actionBusy || !serviceEntries.length} onClick={() => void complete(() => onCopy(formatEntries(serviceEntries.slice(-count)), `Last ${Math.min(count, serviceEntries.length)} lines copied`), close)}>Copy last {count} lines<span>selected service / stream</span></button>)}
        <button role="menuitem" disabled={actionBusy || !filteredEntries.length} onClick={() => { close(); const text = formatGroups(filtered); setConfirmation({ title: 'Export filtered logs?', description: `Export ${filteredEntries.length} matching lines from ${project.name}. Logs may contain sensitive information despite best-effort masking. Review before sharing. A native Save dialog will choose the local file.`, confirmText: 'Choose file…', action: () => { void complete(() => onExport(text)); } }); }}><Download size={14} />Export filtered logs…</button>
        <button role="menuitem" onClick={() => { resetFilters(); close(); }}>Clear view / filters<span>keeps log history</span></button>
        <button role="menuitem" disabled={!filteredEntries.length} onClick={() => { close(); const entries = filteredEntries.slice(); setConfirmation({ title: 'Clear matching buffered history?', description: `Remove ${entries.length} matching lines from this project's shared session history in all Logs views. Project files and services are unaffected. This cannot be undone.`, confirmText: 'Clear buffered history', destructive: true, action: () => onClear(entries) }); }}><Trash2 size={14} />Clear matching buffered history…</button>
      </>}</FloatingMenu>
    </div>
    <div className="console-filterbar">
    <div className="log-category-filters" role="group" aria-label="Filter by log category">{([['all', 'All', categoryStats.entries], ['error', 'Errors', categoryStats.counts.error], ['warning', 'Warnings', categoryStats.counts.warning], ['success', 'Success', categoryStats.counts.success], ['info', 'Info', categoryStats.counts.info], ['http', 'HTTP requests', categoryStats.requests]] as const).map(([id, label, count]) => <button key={id} className={`category-chip${categoryFilter === id ? ' is-active' : ''} ${id !== 'all' && id !== 'http' ? `chip-${id}` : ''}`} aria-pressed={categoryFilter === id} onClick={() => { setAutoScroll(false); setActiveIssue(null); setCategoryFilter(id); }}>{label}<span>{count.toLocaleString()}</span></button>)}</div>
    <div className="log-navigation"><div className="issue-navigation" role="group" aria-label="Navigate matching issues">{(['error', 'warning'] as const).map(category => <span key={category}><span>{category === 'error' ? 'Errors' : 'Warnings'}</span><button aria-label={`Previous ${category}`} title={`Previous ${category}`} disabled={!(category === 'error' ? visibleErrors : visibleWarnings).length} onClick={() => navigateIssue(category, -1)}>↑</button><button aria-label={`Next ${category}`} title={`Next ${category}`} disabled={!(category === 'error' ? visibleErrors : visibleWarnings).length} onClick={() => navigateIssue(category, 1)}>↓</button></span>)}</div></div>
    </div>
    <div ref={consoleRef} className="log-viewport-wrap"><LogViewport groups={filtered} scope={JSON.stringify([project.id, filter, streamFilter, deferredSearch, categoryFilter])} follow={autoScroll} onPause={() => setAutoScroll(false)} fontSize={fontSize} wrap={wrap} layoutKey={`${showTime}:${showService}`} target={activeIssue} targetRequest={issueRequest + (focusIncident?.request || 0)} renderRow={renderGroup} onVisible={setVisibleGroups} empty={<div className="log-empty"><Terminal size={22} /><strong>{logs.length ? 'No matching output' : 'No output to show'}</strong><span>{logs.length ? 'Adjust the service, stream, severity, or search filters.' : 'Start a service to see its output here.'}</span></div>} />{!autoScroll && filtered.length > 0 && <button className="jump-latest" onClick={() => { setActiveIssue(null); setAutoScroll(true); }}><ArrowRight size={14} />Jump to latest</button>}</div>
    <div className="log-footer"><span><span className="live-indicator" /> {filteredEntries.length.toLocaleString()} matching entries · {stats.requests.toLocaleString()} HTTP requests</span><span aria-live="polite">{actionMessage || 'Logs stay in this session'}</span></div>
    <p className="log-retention-note">Recent history: {MAX_SERVICE_LOGS.toLocaleString()} per service · {MAX_PROJECT_LOGS.toLocaleString()} per project · {MAX_SESSION_LOGS.toLocaleString()} per session. Text memory budgets: 8 MiB/service · 16 MiB/project · 32 MiB/session (conservative estimate). Older output expires when either limit is reached. Counts describe output lines, not service failures. Repeats show first/latest samples; copy and export retain all buffered lines with best-effort masking.</p>
  </Card>{confirmation && <ConfirmDialog {...confirmation} onCancel={() => setConfirmation(undefined)} onConfirm={() => { const action = confirmation.action; setConfirmation(undefined); action(); }} />}</div>;
}

export function ConfirmDialog({ title, description, confirmText, destructive, onConfirm, onCancel }: { title: string; description: string; confirmText: string; destructive?: boolean; onConfirm: () => void; onCancel: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onCancel]);
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div ref={dialogRef} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description"><button className="dialog-close icon-button" aria-label="Close dialog" onClick={onCancel}><X size={18} /></button><div className="dialog-symbol">{destructive ? <Square size={22} /> : <Check size={22} />}</div><h2 id="dialog-title">{title}</h2><p id="dialog-description">{description}</p><div className="dialog-actions"><Button ref={cancelRef} onClick={onCancel}>Cancel</Button><Button tone={destructive ? 'danger' : 'primary'} onClick={onConfirm}>{confirmText}</Button></div></div></div>;
}

export const icons = { FolderPlus, ArrowRight, Play, Square, Pause };

export function RenameProjectDialog({ currentName, onSave, onCancel }: {
  currentName: string;
  onSave: (trimmedName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(currentName);
  const [validationError, setValidationError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    inputRef.current?.select();
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onCancel(); }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onCancel]);
  const commit = async () => {
    const name = draft.trim();
    if (!name) { setValidationError('Project name cannot be empty.'); inputRef.current?.focus(); return; }
    setValidationError('');
    setSaving(true);
    try { await onSave(name); } finally { setSaving(false); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title">
        <button className="dialog-close icon-button" aria-label="Close dialog" onClick={onCancel}><X size={18} /></button>
        <div className="dialog-symbol"><Pencil size={22} /></div>
        <h2 id="rename-dialog-title">Rename project</h2>
        <p>Enter a new display name. The project folder, ID, and all service configurations will remain unchanged.</p>
        <label className="rename-dialog-label">PROJECT NAME
          <input
            ref={inputRef}
            className="rename-dialog-input"
            value={draft}
            maxLength={120}
            aria-describedby={validationError ? 'rename-dialog-error' : undefined}
            onChange={e => { setDraft(e.target.value); setValidationError(''); }}
            onKeyDown={e => { if (e.key === 'Enter' && !saving) void commit(); }}
          />
        </label>
        {validationError && <p id="rename-dialog-error" className="rename-dialog-error" role="alert">{validationError}</p>}
        <div className="dialog-actions">
          <Button onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button tone="primary" onClick={() => void commit()} disabled={saving}>Save name</Button>
        </div>
      </div>
    </div>
  );
}

function roleForFramework(framework: string, fallback = 'other') {
  if (framework === 'Next.js' || framework === 'Vite/React') return 'frontend';
  if (framework === 'FastAPI' || framework === 'Flask' || framework === 'Django') return 'backend';
  return fallback;
}
function friendlyWindowsPath(value: string) {
  return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '');
}

export function AddServiceDialog({ candidates, projectRoot, onAdd, onSuggest, onCancel }: {
  candidates: Service[];
  projectRoot: string;
  onAdd: (service: Service) => void;
  onSuggest: (cwd: string, framework: string) => Promise<Service | null>;
  onCancel: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState(candidates[0]?.id || 'manual');
  const selected = candidates.find(candidate => candidate.id === selectedKey);
  const [framework, setFramework] = useState(selected?.framework || 'Custom');
  const [suggestion, setSuggestion] = useState<Service | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)')];
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onCancel]);
  const selectCandidate = (key: string) => {
    const candidate = candidates.find(item => item.id === key);
    setSelectedKey(key);
    setFramework(candidate?.framework || 'Custom');
    setSuggestion(null);
  };
  useEffect(() => {
    let disposed = false;
    if (!['FastAPI', 'Flask', 'Django'].includes(framework)) { setSuggestion(null); return () => { disposed = true; }; }
    setSuggesting(true);
    void onSuggest(selected?.cwd || projectRoot, framework).then(value => { if (!disposed) setSuggestion(value); }).catch(() => { if (!disposed) setSuggestion(null); }).finally(() => { if (!disposed) setSuggesting(false); });
    return () => { disposed = true; };
  }, [framework, onSuggest, projectRoot, selected?.cwd]);
  const sameFramework = selected?.framework === framework;
  const suggested = suggestion?.framework === framework ? suggestion : null;
  const preview = selected ? {
    ...selected,
    framework,
    role: roleForFramework(framework, selected.role || 'other'),
    program: suggested?.program || (sameFramework ? selected.program : ''),
    args: suggested?.args.length ? suggested.args : (sameFramework ? selected.args : []),
    port: suggested?.port ?? (sameFramework ? selected.port : undefined),
    host: suggested?.host ?? (sameFramework ? selected.host : undefined),
    interpreterPath: suggested?.interpreterPath || selected.interpreterPath,
    entryPoint: suggested?.entryPoint || selected.entryPoint,
    confidence: suggested?.confidence || selected.confidence,
    reviewNote: suggested?.reviewNote || selected.reviewNote,
  } : suggested || { id: '', name: 'New service', cwd: projectRoot, program: '', args: [], role: roleForFramework(framework), framework, host: undefined, port: undefined };
  const uncertain = !selected || Boolean(selected.reviewNote) || !selected.program.trim();
  const commit = () => {
    const service: Service = selected ? {
      ...preview,
      reviewNote: sameFramework ? selected.reviewNote : 'Framework selected manually. Enter and review a verified command before starting.',
    } : {
      ...preview,
      id: `service-${crypto.randomUUID()}`,
      reviewNote: 'Manual service. Enter and review its working directory and command before starting.',
    };
    onAdd(service);
  };
  return <div className="dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel(); }}><div ref={dialogRef} className="dialog add-service-dialog" role="dialog" aria-modal="true" aria-labelledby="add-service-title"><button className="dialog-close icon-button" aria-label="Close dialog" onClick={onCancel}><X size={18} /></button><div className="dialog-symbol"><FolderPlus size={22} /></div><h2 id="add-service-title">Add service</h2><p>Choose a discovered service or add a manual configuration. Nothing starts automatically.</p>{!candidates.length && <p className="add-service-empty" role="status">No unconfigured discovered services were found. You can still add a manual service.</p>}<div className="service-candidates" role="list">{candidates.map(candidate => <button key={candidate.id} type="button" role="listitem" className={`service-candidate${selectedKey === candidate.id ? ' is-selected' : ''}`} onClick={() => selectCandidate(candidate.id)}><span><strong>{candidate.name}</strong><small>{candidate.reviewNote ? 'Suggested · review required' : 'Detected'}</small></span><span>{candidate.role || 'other'} · {candidate.framework || 'Unknown'}</span><code>{candidate.cwd}</code></button>)}<button type="button" role="listitem" className={`service-candidate${selectedKey === 'manual' ? ' is-selected' : ''}`} onClick={() => selectCandidate('manual')}><span><strong>Manual / custom service</strong><small>Manual</small></span><span>Other · Custom</span><code>Start from the project root and edit every field</code></button></div>{uncertain ? <label className="add-service-framework">FRAMEWORK<select value={framework} onChange={event => { setFramework(event.target.value); setSuggestion(null); }}>{framework && !serviceFrameworks.includes(framework as typeof serviceFrameworks[number]) && <option>{framework}</option>}{serviceFrameworks.map(option => <option key={option}>{option}</option>)}</select><small>{suggesting ? 'Inspecting the working directory for a verified command…' : 'Framework selection re-runs bounded discovery and only applies verified interpreter/entry-point suggestions.'}</small></label> : <div className="add-service-detected">Detected framework: <strong>{framework}</strong></div>}<dl className="service-preview"><div><dt>Role</dt><dd>{preview.role || 'other'}</dd></div><div><dt>Framework</dt><dd>{preview.framework || 'Custom'}</dd></div><div><dt>Working directory</dt><dd>{preview.cwd}</dd></div><div><dt>Executable</dt><dd>{preview.program || 'Requires review'}</dd></div><div><dt>Arguments</dt><dd>{preview.args.length ? preview.args.join(' ') : 'None detected'}</dd></div><div><dt>ASGI target</dt><dd>{preview.entryPoint || 'Not verified'}</dd></div><div><dt>Interpreter</dt><dd>{preview.interpreterPath || 'Not found'}</dd></div><div><dt>Confidence</dt><dd>{preview.confidence || 'Not assessed'}</dd></div><div><dt>Port</dt><dd>{preview.port || 'Not detected'}</dd></div></dl><div className="dialog-actions"><Button ref={cancelRef} onClick={onCancel}>Cancel</Button><Button tone="primary" onClick={commit}>Add service</Button></div></div></div>;
}
