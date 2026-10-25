import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowRight, Check, ChevronDown, Clipboard, Copy, Download, FolderClosed, FolderOpen, FolderPlus, LayoutDashboard, Moon, Pause, Play, Plus, RotateCcw, Search, Settings2, Square, Sun, Terminal, Trash2, X } from 'lucide-react';
import type { Project, Service, Theme, View } from './types';
import { buildAiDebugPrompt, formatEntry, groupLogs, parseHttp, serviceGroup, summarizeGroups } from './log-utils';
import type { LogCategory, LogEntry, LogGroup } from './log-utils';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'quiet' | 'danger'; icon?: React.ReactNode };
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ tone = 'secondary', icon, children, className = '', ...props }, ref) {
  return <button ref={ref} className={`button button-${tone} ${className}`} {...props}>{icon}{children}</button>;
});

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Status({ running, error }: { running: boolean; error?: boolean }) {
  return <span className={`status status-${error ? 'error' : running ? 'running' : 'stopped'}`}><span className="status-dot" />{error ? 'Error' : running ? 'Running' : 'Stopped'}</span>;
}

const navigation: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <LayoutDashboard size={18} /> },
  { id: 'projects', label: 'Projects', icon: <FolderClosed size={18} /> },
  { id: 'logs', label: 'Logs', icon: <Terminal size={18} /> },
  { id: 'settings', label: 'Settings', icon: <Settings2 size={18} /> },
];

export function Sidebar({ view, setView, projects, selected, selectProject, runningCount, theme, setTheme, importProject }: {
  view: View; setView: (view: View) => void; projects: Project[]; selected: string; selectProject: (id: string) => void;
  runningCount: number; theme: Theme; setTheme: (theme: Theme) => void; importProject: () => void;
}) {
  return <aside className="sidebar" aria-label="Main navigation">
    <div className="brand"><span className="brand-mark"><Activity size={21} strokeWidth={2.5} /></span><span className="brand-name">DevFlow<span className="brand-period">.</span></span><span className="brand-tag">BETA</span></div>
    <div className="sidebar-section-label">WORKSPACE</div>
    <nav className="nav-list" aria-label="Views">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'is-active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>{item.icon}<span>{item.label}</span>{item.id === 'logs' && runningCount > 0 && <span className="nav-count">{runningCount}</span>}</button>)}</nav>
    <div className="sidebar-divider" />
    <div className="sidebar-section-label sidebar-project-label"><span>YOUR PROJECTS</span><span>{projects.length}</span></div>
    <div className="sidebar-projects">{projects.length === 0 ? <p className="sidebar-empty">No projects yet</p> : projects.map(project => <button key={project.id} className={`sidebar-project ${selected === project.id && view === 'projects' ? 'is-selected' : ''}`} onClick={() => { selectProject(project.id); setView('projects'); }}><span className="project-initial">{project.name.slice(0, 1).toUpperCase()}</span><span className="sidebar-project-name">{project.name}</span><span className="sidebar-project-count">{project.services.length}</span></button>)}</div>
    <Button className="sidebar-import" tone="quiet" icon={<Plus size={16} />} onClick={importProject}>Add project</Button>
    <div className="sidebar-bottom"><button className="theme-shortcut" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === 'system' ? 'System theme' : `${theme[0].toUpperCase()}${theme.slice(1)} theme`}</span></button><div className="local-note"><span className="local-dot" /> Local workspace</div></div>
  </aside>;
}

export function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{description}</p>{action}</div>;
}

function FloatingMenu({ label, icon, triggerClassName = 'button button-secondary', align = 'start', children }: {
  label: string; icon: React.ReactNode; triggerClassName?: string; align?: 'start' | 'end'; children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, left: 8, maxHeight: window.innerHeight - 16 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
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
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target))) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, align]);
  return <div className="floating-menu-anchor"><button ref={trigger} type="button" className={triggerClassName} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>{icon}{label}<ChevronDown size={13} /></button>{open && createPortal(<div ref={panel} className="floating-menu-panel" role="menu" style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}>{children(close)}</div>, document.body)}</div>;
}

export function ProjectShortcuts({ project, onTerminal, onFolder, onCopyPath }: {
  project: Project; onTerminal: (path: string) => Promise<void>; onFolder: (path: string) => Promise<void>; onCopyPath: (path: string) => Promise<boolean>;
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
  return <div className="directory-shortcuts" aria-label="Project shortcuts">{menu('terminal')}{menu('folder')}{menu('copy')}</div>;
}

export function ServiceRow({ service, running, error, busy, onEdit, onStart, onStop, onRestart, onRemove }: {
  service: Service; running: boolean; error?: boolean; busy: boolean; onEdit: (field: keyof Service, value: string) => void;
  onStart: () => void; onStop: () => void; onRestart: () => void; onRemove: () => void;
}) {
  return <Card className="service-card"><div className="service-header"><span className="service-icon"><Terminal size={18} /></span><div className="service-identity"><input className="service-name" aria-label={`Name for ${service.name}`} value={service.name} onChange={e => onEdit('name', e.target.value)} /><span className="service-caption">Local service</span></div><Status running={running} error={error} /><div className="service-actions"><Button tone="quiet" aria-label={`Restart ${service.name}`} title="Restart" disabled={!running || busy} onClick={onRestart} icon={<RotateCcw size={16} />} /><Button tone="quiet" aria-label={`${running ? 'Stop' : 'Start'} ${service.name}`} title={running ? 'Stop' : 'Start'} disabled={busy} onClick={running ? onStop : onStart} icon={running ? <Square size={16} /> : <Play size={16} />} /><Button tone="quiet" aria-label={`Remove ${service.name}`} title="Remove" disabled={running || busy} onClick={onRemove} icon={<Trash2 size={16} />} /></div></div><div className="service-fields"><label>WORKING DIRECTORY<input value={service.cwd} onChange={e => onEdit('cwd', e.target.value)} spellCheck={false} /></label><label>EXECUTABLE<input value={service.program} onChange={e => onEdit('program', e.target.value)} spellCheck={false} /></label><label>ARGUMENTS <span className="label-hint">ONE PER LINE</span><textarea rows={Math.max(2, Math.min(4, service.args.length))} value={service.args.join('\n')} onChange={e => onEdit('args', e.target.value)} spellCheck={false} /></label></div></Card>;
}

type CategoryFilter = 'all' | LogCategory | 'http';

function MessageText({ message, slowMs }: { message: string; slowMs: number }) {
  const http = parseHttp(message);
  if (!http) return <>{message}</>;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  http.spans.forEach((span, index) => {
    if (span.start < cursor) return;
    if (span.start > cursor) pieces.push(message.slice(cursor, span.start));
    const slow = span.kind === 'duration' && (http.durationMs ?? 0) >= slowMs;
    pieces.push(<span key={`${span.kind}-${index}`} className={`log-token log-token-${span.kind}${slow ? ' is-slow' : ''}`} title={slow ? `Slow request: ${http.durationMs} ms (threshold ${slowMs} ms)` : undefined}>{message.slice(span.start, span.end)}</span>);
    cursor = span.end;
  });
  pieces.push(message.slice(cursor));
  return <>{pieces}</>;
}

export function LogViewer({ project, logs, filter, setFilter, search, setSearch, autoScroll, setAutoScroll, onCopy, onExport, onClear, actionMessage }: {
  project: Project; logs: LogEntry[]; filter: string; setFilter: (value: string) => void; search: string; setSearch: (value: string) => void;
  autoScroll: boolean; setAutoScroll: (value: boolean) => void; onCopy: (text: string, message: string) => Promise<boolean>; onExport: (text: string) => void; onClear: (entries: LogEntry[]) => void; actionMessage: string;
}) {
  const logViewport = useRef<HTMLDivElement>(null);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [slowMs, setSlowMs] = useState(1000);
  const [copiedRow, setCopiedRow] = useState('');
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const groups = useMemo(() => groupLogs(logs), [logs]);
  const serviceNames = useMemo(() => new Map(project.services.map(service => [service.id, service.name])), [project.services]);
  const serviceScoped = useMemo(() => groups.filter(group => filter === 'all' || group.entries[0].serviceId === filter), [groups, filter]);
  const searched = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return serviceScoped.filter(group => !query || group.searchText.includes(query));
  }, [serviceScoped, search]);
  const filtered = useMemo(() => {
    return searched.filter(group => {
      if (categoryFilter === 'http' && !group.http) return false;
      if (categoryFilter !== 'all' && categoryFilter !== 'http' && group.category !== categoryFilter) return false;
      return true;
    });
  }, [searched, categoryFilter]);
  const stats = useMemo(() => summarizeGroups(filtered), [filtered]);
  const categoryStats = useMemo(() => summarizeGroups(searched), [searched]);
  useEffect(() => {
    if (!autoScroll || !logViewport.current) return;
    logViewport.current.scrollTop = logViewport.current.scrollHeight;
    setAwayFromLatest(false);
  }, [filtered, autoScroll]);

  const formatGroups = (selection: LogGroup[]) => selection.flatMap(group => group.entries.map(entry => formatEntry(entry, serviceNames.get(entry.serviceId) || entry.serviceId))).join('\n');
  const copy = (selection: LogGroup[], label: string, includeContext = false) => {
    let chosen = selection;
    if (includeContext && selection.length) {
      const selectedIndices = new Set(selection.map(group => group.index));
      selection.forEach(group => [group.index - 2, group.index - 1, group.index + 1, group.index + 2].forEach(index => { if (groups[index]?.entries[0].serviceId === group.entries[0].serviceId) selectedIndices.add(index); }));
      chosen = groups.filter(group => selectedIndices.has(group.index));
    }
    return onCopy(formatGroups(chosen), label);
  };
  const copyPrompt = () => {
    const errors = selectionFor('errors');
    const relevant = errors.length ? errors : filtered;
    const chosen: LogGroup[] = [];
    const included = new Set<number>();
    relevant.forEach(group => [group.index - 2, group.index - 1, group.index, group.index + 1, group.index + 2].forEach(index => {
      const candidate = groups[index];
      if (candidate && candidate.entries[0].serviceId === group.entries[0].serviceId && !included.has(index)) {
        included.add(index);
        chosen.push(candidate);
      }
    }));
    chosen.sort((left, right) => left.index - right.index);
    const prompt = buildAiDebugPrompt(project, project.services, chosen.flatMap(group => group.entries));
    return onCopy(prompt, 'AI debug prompt copied');
  };
  const servicesIn = (kind: 'frontend' | 'backend') => new Set(project.services.filter(service => serviceGroup(service) === kind).map(service => service.id));
  const selectionFor = (kind: 'all' | 'frontend' | 'backend' | 'errors' | 'frontend-errors' | 'backend-errors' | 'current') => {
    if (kind === 'current') return filtered;
    const serviceIds = kind.includes('frontend') ? servicesIn('frontend') : kind.includes('backend') ? servicesIn('backend') : null;
    const errorsOnly = kind === 'errors' || kind.endsWith('-errors');
    return groups.filter(group => (!serviceIds || serviceIds.has(group.entries[0].serviceId)) && (!errorsOnly || group.category === 'error'));
  };
  const exportText = formatGroups(filtered);
  const filteredEntries = filtered.flatMap(group => group.entries);
  const visibleErrors = filtered.filter(group => group.category === 'error');
  const visibleWarnings = filtered.filter(group => group.category === 'warning');
  const renderGroup = (group: LogGroup) => {
    const first = group.entries[0];
    const text = group.entries.map(entry => entry.message).join('\n');
    const copyId = `${first.serviceId}-${first.receivedAt}-${group.index}`;
    const groupDetails = group.http;
    const statusKind = groupDetails ? groupDetails.status < 300 ? 'success' : groupDetails.status < 400 ? 'redirect' : groupDetails.status < 500 ? 'client-error' : 'server-error' : '';
    return <div key={copyId} className={`log-row log-category-${group.category}${group.entries.length > 1 ? ' is-grouped' : ''}${groupDetails && groupDetails.status >= 400 && groupDetails.status < 500 ? ' is-http-client' : ''}`}>
      <span className="log-row-time">{new Date(first.receivedAt).toLocaleTimeString()}</span>
      <span className="log-service">{serviceNames.get(first.serviceId) || first.serviceId}</span>
      <span className={`log-stream stream-${first.stream}`}>{first.stream}</span>
      <div className="log-row-content">
        {group.entries.length > 1 ? <details className="log-stack-details"><summary><span className="log-level">{group.category}</span><MessageText message={first.message} slowMs={slowMs} /><span className="stack-line-count">{group.entries.length} lines · expand traceback</span></summary><pre className="log-message">{text}</pre></details> : <div className="log-message"><span className="log-level">{group.category}</span><MessageText message={text} slowMs={slowMs} /></div>}
        {groupDetails && <div className="http-meta"><span className="http-method">{groupDetails.method}</span><span className="http-endpoint">{groupDetails.endpoint}</span><span className={`http-status is-${statusKind}`}>{groupDetails.status}</span>{groupDetails.durationMs !== undefined && <span className={`http-duration${groupDetails.durationMs >= slowMs ? ' is-slow' : ''}`}>{groupDetails.durationMs < 1000 ? `${Math.round(groupDetails.durationMs)} ms` : `${(groupDetails.durationMs / 1000).toFixed(2)} s`}{groupDetails.durationMs >= slowMs ? ' · slow' : ''}</span>}</div>}
      </div>
      <button className={`log-copy-row${copiedRow === copyId ? ' is-copied' : ''}`} aria-label={`Copy ${group.category === 'error' ? 'error block' : 'log entry'} from ${serviceNames.get(first.serviceId) || first.serviceId}`} title={copiedRow === copyId ? 'Copied' : 'Copy log entry'} onClick={() => { void copy([group], 'Log entry copied', group.category === 'error').then(success => { if (success) { setCopiedRow(copyId); window.setTimeout(() => setCopiedRow(''), 1300); } }); }}>{copiedRow === copyId ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>;
  };

  return <Card className="log-panel">
    <div className="panel-heading"><div><span className="eyebrow">OUTPUT / {project.name.toUpperCase()}</span><h2>Debug console <span className="heading-count">{stats.entries.toLocaleString()} entries</span></h2></div><div className="toolbar-actions">
      <FloatingMenu label="Copy" icon={<Clipboard size={15} />} triggerClassName="button button-quiet" align="end">{close => <>
        {([['all', 'All combined logs'], ['frontend', 'Frontend logs'], ['backend', 'Backend logs'], ['errors', 'All errors'], ['frontend-errors', 'Frontend errors'], ['backend-errors', 'Backend errors'], ['current', 'Current filtered view']] as const).map(([kind, label]) => <button key={kind} role="menuitem" onClick={() => { void copy(selectionFor(kind), `${label} copied`); close(); }}>{label}<span>{selectionFor(kind).flatMap(group => group.entries).length}</span></button>)}
        <button role="menuitem" onClick={() => { void copy(visibleErrors, 'Visible errors copied'); close(); }}>Visible errors<span>{visibleErrors.flatMap(group => group.entries).length}</span></button>
        <button role="menuitem" onClick={() => { void copy(visibleWarnings, 'Visible warnings copied'); close(); }}>Visible warnings<span>{visibleWarnings.flatMap(group => group.entries).length}</span></button>
        <button role="menuitem" onClick={() => { void copyPrompt(); close(); }}>Copy as AI Debug Prompt<span>best effort masking</span></button>
      </>}</FloatingMenu>
      <Button tone="quiet" icon={<Download size={15} />} onClick={() => { onExport(exportText); }} disabled={!filteredEntries.length}>Export</Button><Button tone="quiet" icon={<Trash2 size={15} />} onClick={() => onClear(filteredEntries)} disabled={!filteredEntries.length}>Clear visible</Button>
    </div></div>
    <div className="log-summary" aria-label="Log summary"><span><b>{stats.entries.toLocaleString()}</b> entries</span><span className="summary-error"><b>{stats.counts.error.toLocaleString()}</b> errors</span><span className="summary-warning"><b>{stats.counts.warning.toLocaleString()}</b> warnings</span><span className="summary-success"><b>{stats.counts.success.toLocaleString()}</b> success</span><span><b>{stats.counts.info.toLocaleString()}</b> info</span><span className="summary-http"><b>{stats.requests.toLocaleString()}</b> HTTP requests</span></div>
    <div className="log-tabs" role="group" aria-label="Service log filter"><button className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Combined</button>{project.services.map(service => { const kind = serviceGroup(service); const label = kind ? `${kind[0].toUpperCase()}${kind.slice(1)}` : service.name; return <button key={service.id} className={filter === service.id ? 'is-active' : ''} onClick={() => setFilter(service.id)}>{label}</button>; })}</div>
    <div className="log-controls"><label className="search-field"><Search size={16} /><span className="sr-only">Search logs</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search messages, status codes, endpoints" /></label><div className="log-control-options"><label className="slow-threshold">Slow request <input type="number" min="0" max="600000" step="100" value={slowMs} aria-label="Slow request threshold in milliseconds" onChange={event => setSlowMs(Math.min(600000, Math.max(0, Number(event.target.value) || 0)))} /><span>ms</span></label><label className="autoscroll"><input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />Auto-scroll</label></div></div>
    <div className="log-category-filters" role="group" aria-label="Filter by log category">{([['all', 'All', categoryStats.entries], ['error', 'Errors', categoryStats.counts.error], ['warning', 'Warnings', categoryStats.counts.warning], ['success', 'Success', categoryStats.counts.success], ['info', 'Info', categoryStats.counts.info], ['http', 'HTTP requests', categoryStats.requests]] as const).map(([id, label, count]) => <button key={id} className={`category-chip${categoryFilter === id ? ' is-active' : ''} ${id !== 'all' && id !== 'http' ? `chip-${id}` : ''}`} aria-pressed={categoryFilter === id} onClick={() => setCategoryFilter(id)}>{label}<span>{count.toLocaleString()}</span></button>)}</div>
    <div className="log-viewport-wrap"><div className="log-viewport" ref={logViewport} role="log" aria-label="Service output" aria-live="off" onScroll={event => {
      const element = event.currentTarget;
      const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 36;
      setAwayFromLatest(!atBottom);
      if (!atBottom && autoScroll) setAutoScroll(false);
    }}>{filtered.length === 0 ? <div className="log-empty"><Terminal size={22} /><strong>{logs.length ? 'No matching output' : 'No output to show'}</strong><span>{logs.length ? 'Adjust the category or search filters.' : 'Start a service to see its output here.'}</span></div> : filtered.map(renderGroup)}</div>{awayFromLatest && <button className="jump-latest" onClick={() => { setAutoScroll(true); if (logViewport.current) logViewport.current.scrollTop = logViewport.current.scrollHeight; }}><ArrowRight size={14} />Jump to latest</button>}</div>
    <div className="log-footer"><span><span className="live-indicator" /> {filteredEntries.length.toLocaleString()} visible entries · {filtered.filter(group => group.http).length.toLocaleString()} HTTP requests</span><span aria-live="polite">{actionMessage || 'Logs stay in this session'}</span></div>
  </Card>;
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
