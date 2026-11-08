import { useMemo, useState, useSyncExternalStore } from 'react';
import { Activity, ArrowRight, Code2, Cpu, FolderClosed, FolderPlus, ListChecks, Play, Plug, Terminal } from 'lucide-react';
import { Button, Card, EmptyState } from './components';
import type { HealthSnapshot, Project, ServiceExit, View } from './types';
import { serviceKey } from './types';
import type { NotificationStore, Incident } from './notifications';
import { projectServiceState } from './project-service-state';
import './overview.css';

export type EnvironmentSummary = { checkedAt: number; checked: number; installed: number; unavailable: number };
type Props = {
  projects: Project[]; recentProjects: Project[]; project?: Project;
  running: string[]; pending: string[]; stopping: string[];
  errors: Record<string, string>; exits: Record<string, ServiceExit>; health: Record<string, HealthSnapshot>;
  logProjects: Set<string>; notifications: NotificationStore; environment?: EnvironmentSummary; busy: boolean;
  navigate: (view: View, projectId?: string) => void; importProject: () => void;
  start: (project: Project) => void; openIncident: (incident: Incident) => void;
};
const eventLabels: Record<Incident['reason'], string> = {
  exit: 'Service exited', 'start-failed': 'Service start failed', 'stop-failed': 'Service cleanup needs review',
  health: 'HTTP check needs review', recovery: 'Service recovered', 'port-conflict': 'Port conflict reported',
  'log-collection': 'Log collection needs review', 'save-failed': 'Configuration save failed',
  application: 'Application diagnostic', started: 'Service started', stopped: 'Service stopped',
};
const displayPath = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
const timestamp = (value: number) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function Overview(props: Props) {
  const { projects, project, running, pending, stopping, errors, exits, health, navigate, environment } = props;
  const { history } = useSyncExternalStore(props.notifications.subscribe, props.notifications.getSnapshot);
  const [filter, setFilter] = useState<'recent' | 'running' | 'attention'>('recent');
  const summaries = useMemo(() => projects.map(target => {
    const keys = target.services.map(service => serviceKey(target.id, service.id));
    const failed = keys.filter(key => !running.includes(key) && !pending.includes(key) &&
      (Boolean(errors[key]) || Boolean(exits[key] && !exits[key].stopRequested && exits[key].exitCode !== 0))).length;
    return { project: target, running: keys.filter(key => running.includes(key)).length, failed,
      state: projectServiceState(target, running, pending, stopping, errors) };
  }), [projects, running, pending, stopping, errors, exits]);
  const runningCount = summaries.reduce((sum, item) => sum + item.running, 0);
  const failedCount = summaries.reduce((sum, item) => sum + item.failed, 0);
  const activeProjects = summaries.filter(item => item.running > 0).length;
  const recent = [...props.recentProjects, ...projects.filter(item => !props.recentProjects.some(recent => recent.id === item.id))].slice(0, 5);
  const active = summaries.find(item => item.project.id === project?.id);
  const visibleProjects = filter === 'recent' ? recent : summaries.filter(item => filter === 'running' ? item.running > 0 : item.failed > 0).map(item => item.project);
  const startReason = (target: Project) => {
    const summary = summaries.find(item => item.project.id === target.id)!;
    return !target.services.length ? 'Configure services in Projects first.' : summary.state.pending ? 'Wait for the current service operation.' : props.busy ? 'Another service operation is in progress.' : summary.running === target.services.length ? 'All configured services have managed processes.' : '';
  };
  const events = history.filter(item => !item.projectId || projects.some(project => project.id === item.projectId)).slice(0, 5);
  const go = (view: View, target = project) => navigate(target ? view : 'projects', target?.id);
  const summaryCards = [
    { label: 'Saved projects', value: projects.length, description: 'Available on this device', action: () => navigate('projects') },
    { label: 'Running services', value: runningCount, description: `Across ${activeProjects} active project${activeProjects === 1 ? '' : 's'}`, action: () => go('logs', project && summaries.some(item => item.project.id === project.id && item.running) ? project : summaries.find(item => item.running)?.project) },
    { label: 'Attention needed', value: failedCount, description: failedCount ? 'Stopped services with reported failures' : 'No service failures reported', action: () => setFilter('attention') },
    { label: 'Environment', value: environment ? `${environment.installed}/${environment.checked}` : 'Not checked', description: environment ? `${environment.unavailable} unavailable or unknown · ${timestamp(environment.checkedAt)}` : 'Inspect installed development tools', action: () => navigate('environment') },
  ];
  return <div className="command-center">
    <header className="command-header"><div><h1>Overview</h1><p>A clear view of your local development workspace.</p></div><Button tone="primary" icon={<FolderPlus size={16} />} onClick={props.importProject}>Import project</Button></header>
    <div className="command-metrics" aria-label="Workspace status">{summaryCards.map(({ label, value, description, action }) => <button className="command-metric" key={label} onClick={action}><span className="command-metric-label">{label}<ArrowRight size={13} /></span><strong className={label === 'Attention needed' && failedCount ? 'command-error' : ''}>{value}</strong><small>{description}</small></button>)}</div>
    <div className="command-main">
      <div className="command-work">
      <Card className="command-panel command-focus">
        <div className="command-section-heading"><h2>Selected workspace</h2>{active && <span className="command-focus-state">{active.state.pending ? active.state.status : active.failed ? 'Failure reported' : active.project.services.length ? active.state.status : 'Not configured'}</span>}</div>
        {active ? <>
          <h3 className="command-focus-name">{active.project.name}</h3>
          <p className="command-focus-path">{displayPath(active.project.root)}</p>
          <div className="command-focus-actions"><Button tone="primary" onClick={() => go('projects')}>Open project <ArrowRight size={14} /></Button><Button tone="secondary" icon={<Code2 size={15} />} onClick={() => go('editor')}>Quick Editor</Button><Button tone="secondary" icon={<Terminal size={15} />} onClick={() => go('logs')}>View logs</Button></div>
          <div className="command-health-services">{active.project.services.map(service => {
            const key = serviceKey(active.project.id, service.id); const check = health[key];
            const state = stopping.includes(key) ? 'Stopping' : pending.includes(key) ? 'Operation pending' : running.includes(key) ? 'Managed process running' : errors[key] || (exits[key] && !exits[key].stopRequested && exits[key].exitCode !== 0) ? 'Failure reported' : 'No running process';
            return <div className="command-service" key={key}><div><strong>{service.name}</strong><small>{service.framework && service.confidence === 'high' ? `${service.framework} · ` : ''}{check?.checkedAt && running.includes(key) ? `Last HTTP check: ${check.status}${check.statusCode ? ` (${check.statusCode})` : ''} · ${timestamp(check.checkedAt)}` : 'HTTP readiness not checked for a running process'}</small></div><span className={state === 'Failure reported' ? 'command-error' : running.includes(key) ? 'command-running' : ''}>{state}</span></div>;
          })}</div>
          <div className="command-focus-footer"><div><p className="command-note">{props.logProjects.has(active.project.id) ? 'Session logs available' : 'No retained session logs'} · {active.project.services.length} configured service{active.project.services.length === 1 ? '' : 's'}</p>{startReason(active.project) && <p className="command-note" id="overview-start-reason">{startReason(active.project)}</p>}</div><Button tone="secondary" icon={<Play size={14} />} disabled={Boolean(startReason(active.project))} aria-describedby={startReason(active.project) ? 'overview-start-reason' : undefined} onClick={() => props.start(active.project)}>Start services</Button></div>
        </> : <div className="command-empty"><h3>{projects.length ? 'Choose where to pick up' : 'Your next workspace starts here'}</h3><p>{projects.length ? 'Select a saved project to see its services and session logs.' : 'Import a project folder, review its commands, then run it locally.'}</p><Button tone="primary" onClick={projects.length ? () => navigate('projects') : props.importProject}>{projects.length ? 'Choose project' : 'Import project'}<ArrowRight size={14} /></Button></div>}
      </Card>
      <section className="command-continue" aria-labelledby="overview-projects-title"><div className="command-section-heading"><h2 id="overview-projects-title">Your projects</h2><Button tone="quiet" onClick={() => navigate('projects')}>All projects <ArrowRight size={14} /></Button></div>
        <div className="command-filters" role="group" aria-label="Filter projects">{(['recent', 'running', 'attention'] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'recent' ? 'Recent' : value === 'running' ? 'Running' : 'Needs attention'}</button>)}</div>
        <p className="command-note command-project-caption" role="status">{filter === 'recent' ? 'Up to five projects, with recent selections first.' : `${visibleProjects.length} project${visibleProjects.length === 1 ? '' : 's'} ${filter === 'running' ? 'with managed processes.' : 'with stopped services reporting failures.'}`} Running indicates a managed process, not HTTP readiness.</p>
        {visibleProjects.length ? <div className="command-projects">{visibleProjects.map(target => {
          const summary = summaries.find(item => item.project.id === target.id)!;
          const status = summary.state.pending ? summary.state.status : summary.failed ? 'Failure reported' : target.services.length ? summary.state.status : 'Not configured';
          const reason = startReason(target);
          return <article className={'command-project' + (project?.id === target.id ? ' is-selected' : '')} key={target.id}>
            <div className="command-project-heading"><span className="command-project-icon"><FolderClosed size={18} /></span><div><h3>{target.name}</h3><span className="command-path" title={displayPath(target.root)}>{displayPath(target.root)}</span></div><span className={'command-state' + (summary.failed ? ' command-error' : summary.running ? ' command-running' : '')}>{status}</span></div>
            <div className="command-project-meta"><span>{target.services.length} configured</span><span>{summary.running} running</span>{project?.id === target.id && <span>Selected project</span>}</div>
            <div className="command-project-actions"><Button tone="secondary" aria-label={`Open project ${target.name}`} onClick={() => go('projects', target)}>Open project <ArrowRight size={13} /></Button><details className="command-project-tools"><summary>Project tools</summary><div><Button tone="quiet" icon={<Code2 size={14} />} onClick={() => go('editor', target)}>Editor</Button><Button tone="quiet" icon={<Terminal size={14} />} onClick={() => go('logs', target)}>Logs</Button>{target.services.some(service => service.port) && <Button tone="quiet" onClick={() => go('ports', target)}>Inspect ports</Button>}<Button tone="quiet" icon={<Play size={13} />} disabled={Boolean(reason)} onClick={() => props.start(target)}>Start services</Button></div>{reason && <p className="command-note">{reason}</p>}</details></div>
          </article>;
        })}</div> : projects.length ? <div className="command-empty"><p>No projects match “{filter === 'running' ? 'Running' : 'Needs attention'}”.</p><Button tone="quiet" onClick={() => setFilter('recent')}>Show recent projects <ArrowRight size={14} /></Button></div> : <EmptyState icon={<FolderPlus size={24} />} title="No saved projects yet" description="Imported projects will appear here." />}
      </section>
      </div>
      <aside className="command-side" aria-label="Workspace tools and activity">
      <section className="command-tools"><div className="command-section-heading"><h2>Quick actions</h2></div><p className="command-note">{project ? <>Project tools target <strong>{project.name}</strong>.</> : 'Choose a project to use project tools.'}</p><div className="command-shortcuts">{[
        { label: 'Quick Editor', detail: 'Files, snapshots & AI Assistant', icon: Code2, action: () => go('editor') },
        { label: 'View logs', detail: 'Shared service output', icon: Terminal, action: () => go('logs') },
        { label: 'API Tester', detail: 'Prepare local requests', icon: Plug, action: () => go('api') },
        { label: 'Port Manager', detail: 'Inspect listeners on demand', icon: ListChecks, action: () => go('ports') },
        { label: 'Developer Environment', detail: 'Check tools on demand', icon: Terminal, action: () => navigate('environment') },
        { label: 'System Monitor', detail: 'Open resource inspection', icon: Cpu, action: () => navigate('system') },
      ].map(({ label, detail, icon: Icon, action }) => <button key={label} onClick={action}><Icon size={17} /><span><strong>{label}</strong><small>{detail}</small></span><ArrowRight size={14} /></button>)}</div></section>
      <section className="command-activity"><div className="command-section-heading"><h2>Recent activity</h2><span className="command-section-meta">This device</span></div><p className="command-note">Recorded events, not current incident status.</p>{events.length ? <div className="command-events">{events.map(event => <button key={event.id} onClick={() => props.openIncident(event)}><span className={'command-event-icon' + (event.resolved ? ' command-running' : event.severity === 'error' ? ' command-error' : '')}><Activity size={15} /></span><span><strong>{eventLabels[event.reason]}</strong><small>{projects.find(item => item.id === event.projectId)?.name ?? 'DevFlow'} · {event.resolved ? 'Resolved' : 'Recorded report'}</small><time dateTime={new Date(event.updatedAt).toISOString()} title={new Date(event.updatedAt).toLocaleString()}>{timestamp(event.updatedAt)}</time></span><ArrowRight size={13} /></button>)}</div> : <p className="command-empty">No recorded events yet. Diagnostics and lifecycle events will appear here.</p>}</section>
      </aside>
    </div>
  </div>;
}
