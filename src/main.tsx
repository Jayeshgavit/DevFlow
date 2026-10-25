import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowRight, FolderPlus, Play, Save, Settings2, Square, Terminal, X } from 'lucide-react';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import { Button, Card, ConfirmDialog, EmptyState, LogViewer, ProjectShortcuts, ServiceRow, Sidebar, Status } from './components';
import type { LogLine, Project, Service, Theme, View } from './types';
import type { LogEntry } from './log-utils';
import { serviceKey } from './types';
import { ProjectStore, type ProjectSnapshot } from './project-store';
import './style.css';

const storedTheme = (): Theme => { try { const value = localStorage.getItem('devflow-theme'); return value === 'dark' || value === 'light' || value === 'system' ? value : 'system'; } catch { return 'system'; } };
const storedCompact = () => { try { return localStorage.getItem('devflow-compact') === 'true'; } catch { return false; } };

function App() {
  const [projectSnapshot, setProjectSnapshot] = useState<ProjectSnapshot>({ status: 'loading', projects: [], dirty: false, loadError: '' });
  const projectStoreRef = useRef<ProjectStore | null>(null);
  if (!projectStoreRef.current) projectStoreRef.current = new ProjectStore(
    () => invoke<Project[]>('load_projects'),
    projects => invoke('save_projects', { projects }),
    setProjectSnapshot,
  );
  const projectStore = projectStoreRef.current;
  const projects = projectSnapshot.projects;
  const dirty = projectSnapshot.dirty;
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<View>('overview');
  const [running, setRunning] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState('');
  const [serviceErrors, setServiceErrors] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [compact, setCompact] = useState(storedCompact);
  const [recentIds, setRecentIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('devflow-recent') || '[]') as string[]; } catch { return []; } });
  const [confirm, setConfirm] = useState<{ title: string; description: string; confirmText: string; destructive?: boolean; action: () => void } | null>(null);

  const project = projects.find(item => item.id === selected);
  const runningCount = running.filter(key => projects.some(item => item.services.some(service => serviceKey(item.id, service.id) === key))).length;
  const projectRunning = project?.services.filter(service => running.includes(serviceKey(project.id, service.id))).length || 0;
  const recentProjects = recentIds.map(id => projects.find(item => item.id === id)).filter((item): item is Project => Boolean(item));

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    apply(); media.addEventListener('change', apply);
    try { localStorage.setItem('devflow-theme', theme); } catch { /* preference remains in memory */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => { document.documentElement.dataset.density = compact ? 'compact' : 'comfortable'; try { localStorage.setItem('devflow-compact', String(compact)); } catch { /* preference remains in memory */ } }, [compact]);
  useEffect(() => {
    let mounted = true;
    let dispose: (() => void) | undefined;
    const initialize = async () => {
      try {
        dispose = await listen<LogLine>('service-log', event => {
          if (!mounted) return;
          setLogs(current => [...current.slice(-3999), { ...event.payload, receivedAt: Date.now() }]);
          if (event.payload.stream === 'system') invoke<string[]>('running_services').then(keys => { if (mounted) setRunning(keys); }).catch(() => {});
        });
      } catch (cause) {
        if (mounted) setError(String(cause));
      }
      if (!mounted) { dispose?.(); return; }
      projectStore.load().then(items => { if (mounted) setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id || ''); }).catch(() => { /* load error is shown with Retry Load */ });
      invoke<string[]>('running_services').then(keys => { if (mounted) setRunning(keys); }).catch(() => {});
    };
    void initialize();
    return () => { mounted = false; dispose?.(); };
  }, []);

  const retryLoad = async () => {
    try {
      const items = await projectStore.load();
      setSelected(current => items.some(item => item.id === current) ? current : items[0]?.id || '');
      setError('');
    } catch { /* keep the failed state and the original file for another retry */ }
  };

  const selectProject = (id: string) => {
    setSelected(id); setFilter('all'); setSearch('');
    setRecentIds(current => { const next = [id, ...current.filter(value => value !== id)].slice(0, 5); try { localStorage.setItem('devflow-recent', JSON.stringify(next)); } catch { /* list remains in memory */ } return next; });
  };
  const savedMessage = () => setActionMessage(projectStore.current.dirty ? 'Newer edits still need saving' : 'Changes saved');
  const importProject = async () => {
    if (projectStore.current.status !== 'ready') { setError('Retry Load before importing a project.'); return; }
    try { const root = await open({ directory: true, multiple: false, title: 'Select project root' }); if (!root || Array.isArray(root)) return; const detected = await invoke<Project>('detect_project', { root }); await projectStore.updateAndSave(current => [...current, detected]); selectProject(detected.id); setView('projects'); setError(''); savedMessage(); }
    catch (cause) { setError(String(cause)); }
  };
  const editService = (id: string, field: keyof Service, value: string) => {
    if (!project || projectStore.current.status !== 'ready') return;
    projectStore.edit(current => current.map(item => item.id === project.id ? { ...item, services: item.services.map(service => service.id === id ? { ...service, [field]: field === 'args' ? value.split('\n').filter(Boolean) : value } : service) } : item));
  };
  const save = async () => { try { await projectStore.save(); setError(''); savedMessage(); } catch (cause) { setError(String(cause)); } };
  const addService = async () => {
    if (!project || projectStore.current.status !== 'ready') return;
    const id = `service-${Date.now()}`;
    try { await projectStore.updateAndSave(current => current.map(item => item.id === project.id ? { ...item, services: [...item.services, { id, name: 'New service', cwd: item.root, program: '', args: [] }] } : item)); setError(''); savedMessage(); }
    catch (cause) { setError(String(cause)); }
  };
  const removeService = (service: Service) => {
    if (!project || projectStore.current.status !== 'ready' || running.includes(serviceKey(project.id, service.id))) return;
    setConfirm({ title: `Remove ${service.name}?`, description: 'This removes the service from the saved project configuration. It does not delete project files.', confirmText: 'Remove service', destructive: true, action: () => { void projectStore.updateAndSave(current => current.map(item => item.id === project.id ? { ...item, services: item.services.filter(value => value.id !== service.id) } : item)).then(() => { setError(''); savedMessage(); }).catch(cause => setError(String(cause))); } });
  };
  const start = async (target: Project, service: Service) => {
    try { await invoke('start_service', { projectId: target.id, service }); setRunning(await invoke<string[]>('running_services')); setServiceErrors(current => ({ ...current, [serviceKey(target.id, service.id)]: false })); setError(''); }
    catch (cause) { setServiceErrors(current => ({ ...current, [serviceKey(target.id, service.id)]: true })); setError(String(cause)); }
  };
  const stop = async (target: Project, service: Service) => {
    try { await invoke('stop_service', { projectId: target.id, serviceId: service.id }); setRunning(await invoke<string[]>('running_services')); setError(''); return true; }
    catch (cause) { setError(String(cause)); return false; }
  };
  const requestStop = (target: Project, services: Service[]) => {
    setConfirm({ title: services.length === 1 ? `Stop ${services[0].name}?` : `Stop ${services.length} services?`, description: 'Windows currently stops process trees with forced termination. Unsaved work in those processes could be lost.', confirmText: services.length === 1 ? 'Force stop' : 'Force stop all', destructive: true, action: () => { void (async () => { setBusy(true); for (const service of services) await stop(target, service); setBusy(false); })(); } });
  };
  const restart = (target: Project, service: Service) => {
    setConfirm({ title: `Restart ${service.name}?`, description: 'Restart uses forced termination on Windows before starting the service again.', confirmText: 'Restart service', destructive: true, action: () => { void (async () => { setBusy(true); if (await stop(target, service)) { let cleared = false; for (let attempt = 0; attempt < 12; attempt++) { const keys = await invoke<string[]>('running_services').catch(() => [serviceKey(target.id, service.id)]); if (!keys.includes(serviceKey(target.id, service.id))) { cleared = true; break; } await new Promise(resolve => setTimeout(resolve, 250)); } if (cleared) await start(target, service); else setError('Service has not stopped yet. Try again after it exits.'); } setBusy(false); })(); } });
  };
  const runAll = async (target: Project) => { setBusy(true); for (const service of target.services) if (!running.includes(serviceKey(target.id, service.id))) await start(target, service); setBusy(false); };
  const openDirectory = async (path: string, target: 'terminal' | 'folder') => {
    try { await invoke('open_directory', { path, target }); setActionMessage(target === 'terminal' ? 'Terminal opened' : 'Folder opened'); }
    catch (cause) { setError(String(cause)); }
  };
  const copyDirectoryPath = async (path: string) => {
    try { await navigator.clipboard.writeText(path); setActionMessage('Directory path copied'); return true; }
    catch (cause) { setError(`Could not copy directory path: ${String(cause)}`); return false; }
  };
  const logWorkspace = (target: Project) => <LogViewer project={target} logs={logs.filter(line => line.projectId === target.id) as LogEntry[]} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} autoScroll={autoScroll} setAutoScroll={setAutoScroll} onCopy={async (text, message) => { try { await navigator.clipboard.writeText(text); setActionMessage(message); return true; } catch (cause) { setError(`Could not copy logs: ${String(cause)}`); return false; } }} onExport={text => { const blob = new Blob([text], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${target.name}-logs.txt`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setActionMessage('Logs exported'); }} onClear={entries => { const visible = new Set(entries); setLogs(current => current.filter(line => !visible.has(line as LogEntry))); setActionMessage('Visible log stream cleared'); }} actionMessage={actionMessage} />;

  return <div className="app-shell"><Sidebar view={view} setView={setView} projects={projects} selected={selected} selectProject={selectProject} runningCount={runningCount} theme={theme} setTheme={setTheme} importProject={() => void importProject()} /><main className="main-content"><div className="topline"><span>LOCAL DEVELOPMENT / DEVFLOW</span><span className="topline-right"><span className="local-dot" /> ALL SYSTEMS LOCAL</span></div>{error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}{projectSnapshot.status === 'loading' ? <div className="loading-state" role="status">Loading your workspace…</div> : projectSnapshot.status === 'failed' ? <Card className="settings-card"><h2>Could not load saved projects</h2><p role="alert">DevFlow could not read projects.json: {projectSnapshot.loadError}</p><p>Your saved file has not been changed. Check its permissions or JSON contents, then try loading again. Project changes are blocked until it loads successfully.</p><Button tone="primary" onClick={() => void retryLoad()}>Retry Load</Button></Card> : <>
    {view === 'overview' && <><header className="page-header"><div><span className="eyebrow">YOUR WORKSPACE AT A GLANCE</span><h1>Good to see you<span className="accent-period">.</span></h1><p>Pick up where you left off, or bring in a new project.</p></div><Button tone="primary" icon={<FolderPlus size={17} />} onClick={() => void importProject()}>Import project</Button></header><div className="overview-grid"><Card className="summary-card summary-projects"><span className="summary-label">SAVED PROJECTS</span><strong>{projects.length.toString().padStart(2, '0')}</strong><span>Workspaces ready to open</span><FolderPlus className="summary-watermark" size={76} strokeWidth={1} /></Card><Card className="summary-card summary-running"><span className="summary-label">RUNNING SERVICES</span><strong>{runningCount.toString().padStart(2, '0')}</strong><span>Across your saved projects</span><Play className="summary-watermark" size={76} strokeWidth={1} /></Card></div><div className="overview-columns"><Card className="recent-card"><div className="panel-heading"><div><span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>Recent projects</h2></div><Button tone="quiet" onClick={() => setView('projects')}>View all <ArrowRight size={15} /></Button></div>{recentProjects.length ? <div className="recent-list">{recentProjects.map(item => <button key={item.id} className="recent-row" onClick={() => { selectProject(item.id); setView('projects'); }}><span className="recent-initial">{item.name.slice(0, 1).toUpperCase()}</span><span className="recent-info"><strong>{item.name}</strong><small>{item.root}</small></span><span className="recent-meta">{item.services.length} services</span><ArrowRight size={17} /></button>)}</div> : <EmptyState icon={<FolderPlus size={23} />} title="Your projects start here" description="Import a local folder to detect services and build your workspace." action={<Button tone="secondary" onClick={() => void importProject()}>Import a project</Button>} />}</Card><Card className="quick-card"><span className="eyebrow">QUICK START</span><h2>Ready when you are.</h2><p>Choose a saved project, review its commands, then launch the services you need.</p><div className="quick-steps"><span><b>01</b> Import a project</span><span><b>02</b> Review services</span><span><b>03</b> Start and monitor</span></div><Button tone="primary" onClick={() => { if (project) setView('projects'); else void importProject(); }}>{project ? 'Open workspace' : 'Import project'} <ArrowRight size={16} /></Button></Card></div></>}
    {view === 'projects' && <><header className="page-header"><div><span className="eyebrow">PROJECT WORKSPACES</span><h1>Projects<span className="accent-period">.</span></h1><p>Review commands before you run them. Every service stays in your control.</p></div><Button tone="primary" icon={<FolderPlus size={17} />} onClick={() => void importProject()}>Import project</Button></header>{project ? <><div className="project-heading"><div><span className="eyebrow">CURRENT PROJECT</span><h2>{project.name}</h2><p>{project.root}</p></div><div className="project-heading-actions"><ProjectShortcuts project={project} onTerminal={path => openDirectory(path, 'terminal')} onFolder={path => openDirectory(path, 'folder')} onCopyPath={copyDirectoryPath} /><Status running={projectRunning > 0} /><Button icon={<Square size={16} />} disabled={busy || projectRunning === 0} onClick={() => requestStop(project, project.services.filter(service => running.includes(serviceKey(project.id, service.id))))}>Stop all</Button><Button tone="primary" icon={<Play size={16} />} disabled={busy || project.services.length === 0 || projectRunning === project.services.length} onClick={() => void runAll(project)}>Start all</Button></div></div><div className="section-heading"><div><span className="eyebrow">CONFIGURATION</span><h2>Services <span className="heading-count">{project.services.length}</span></h2></div><div className="toolbar-actions"><Button icon={<Save size={15} />} onClick={() => void save()} disabled={!dirty}>Save changes</Button><Button icon={<FolderPlus size={15} />} onClick={() => void addService()}>Add service</Button></div></div>{dirty && <p className="unsaved-note" role="status">Unsaved changes. Save before leaving this session.</p>}<div className="service-list">{project.services.length ? project.services.map(service => <ServiceRow key={service.id} service={service} running={running.includes(serviceKey(project.id, service.id))} error={serviceErrors[serviceKey(project.id, service.id)]} busy={busy} onEdit={(field, value) => editService(service.id, field, value)} onStart={() => void start(project, service)} onStop={() => requestStop(project, [service])} onRestart={() => restart(project, service)} onRemove={() => removeService(service)} />) : <EmptyState icon={<Terminal size={23} />} title="No services detected" description="Add a service and enter its working directory, executable, and arguments." action={<Button onClick={() => void addService()}>Add service</Button>} />}</div><div className="inline-logs"><div className="section-heading"><div><span className="eyebrow">LATEST OUTPUT</span><h2>Activity</h2></div><Button tone="quiet" onClick={() => setView('logs')}>Open logs <ArrowRight size={15} /></Button></div><div className="activity-preview">{logs.filter(line => line.projectId === selected).slice(-3).map((line, index) => <div key={index}><span>{line.serviceId}</span><code>{line.message}</code></div>)}{!logs.some(line => line.projectId === selected) && <p>No output yet. Start a service to see its activity.</p>}</div></div></> : <EmptyState icon={<FolderPlus size={26} />} title="No project selected" description="Import a project folder to detect services, or select a saved project from the sidebar." action={<Button tone="primary" onClick={() => void importProject()}>Import project</Button>} />}</>}
    {view === 'logs' && <><header className="page-header"><div><span className="eyebrow">LIVE OUTPUT</span><h1>Logs<span className="accent-period">.</span></h1><p>Follow stdout and stderr from one service or the full project.</p></div>{project && <><label className="project-picker">PROJECT<select value={selected} onChange={event => selectProject(event.target.value)}>{projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><ProjectShortcuts project={project} onTerminal={path => openDirectory(path, 'terminal')} onFolder={path => openDirectory(path, 'folder')} onCopyPath={copyDirectoryPath} /></>}</header>{project ? logWorkspace(project) : <EmptyState icon={<Terminal size={26} />} title="No project selected" description="Import or select a project to see its service logs." action={<Button tone="primary" onClick={() => void importProject()}>Import project</Button>} />}</>}
    {view === 'settings' && <><header className="page-header"><div><span className="eyebrow">PREFERENCES</span><h1>Settings<span className="accent-period">.</span></h1><p>Make the workspace comfortable for the way you work.</p></div><Settings2 size={23} className="header-icon" /></header><Card className="settings-card"><div className="settings-heading"><span className="settings-symbol">Aa</span><div><h2>Appearance</h2><p>Theme preferences are saved on this device.</p></div></div><div className="setting-row"><div><strong>Color theme</strong><span>Choose a look, or follow Windows.</span></div><div className="segmented-control" role="group" aria-label="Color theme">{(['light', 'dark', 'system'] as Theme[]).map(option => <button key={option} className={theme === option ? 'is-active' : ''} aria-pressed={theme === option} onClick={() => setTheme(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}</div></div><div className="setting-row"><div><strong>Compact layout</strong><span>Fit more services and logs on screen.</span></div><label className="switch"><input type="checkbox" checked={compact} onChange={event => setCompact(event.target.checked)} /><span className="switch-track" /><span className="sr-only">Compact layout</span></label></div></Card><Card className="settings-card about-card"><div className="settings-heading"><span className="settings-symbol"><Terminal size={21} /></span><div><h2>Local by design</h2><p>Projects are saved in DevFlow's local application config. Logs remain in this session.</p></div></div></Card></>}
  </>}</main>{confirm && <ConfirmDialog title={confirm.title} description={confirm.description} confirmText={confirm.confirmText} destructive={confirm.destructive} onCancel={() => setConfirm(null)} onConfirm={() => { const action = confirm.action; setConfirm(null); action(); }} />}</div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
