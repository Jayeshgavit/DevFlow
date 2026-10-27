import { useMemo, useState } from 'react';
import type { Project, Service } from './types';
import { summarizeServiceHealth, type ServiceHealthState, type ServiceHealthStatus } from './service-health-utils';
import './service-health-dashboard.css';

type ServiceAction = (project: Project, service: Service) => void;
type ProjectAction = (project: Project) => void;

export type ServiceHealthActions = {
  onStart?: ServiceAction;
  /** The host must provide its existing forced-stop confirmation. */
  onRequestStop?: ServiceAction;
  /** The host must provide its existing forced-restart confirmation. */
  onRequestRestart?: ServiceAction;
  onStartAll?: ProjectAction;
  /** The host must provide its existing forced-stop confirmation. */
  onRequestStopAll?: ProjectAction;
};

export type ServiceHealthActionResult = {
  label: string;
  state: 'pending' | 'succeeded' | 'failed' | 'skipped';
};

export type ServiceHealthDashboardProps = {
  projects: readonly Project[];
  lifecycle: ServiceHealthState;
  loading?: boolean;
  loadError?: string;
  busyServiceKeys?: readonly string[];
  busyProjectIds?: readonly string[];
  actionByKey?: Readonly<Record<string, ServiceHealthActionResult>>;
  projectActionById?: Readonly<Record<string, ServiceHealthActionResult>>;
  actions?: ServiceHealthActions;
};

const statusOrder: ServiceHealthStatus[] = ['running', 'starting', 'stopping', 'stopped', 'failed', 'exited', 'unknown'];
const statusCopy: Record<ServiceHealthStatus, { label: string; title: string }> = {
  running: { label: 'Running', title: 'A process exists. HTTP readiness has not been checked.' },
  starting: { label: 'Starting', title: 'The launch command is still in progress.' },
  stopping: { label: 'Stopping', title: 'Shutdown is still in progress.' },
  stopped: { label: 'Stopped', title: 'The service is not running, or an intentional stop was reported.' },
  failed: { label: 'Failed', title: 'A startup error or unexpected failure was reported.' },
  exited: { label: 'Exited', title: 'The process exited unexpectedly with a successful exit code.' },
  unknown: { label: 'Unknown', title: 'A current process-state snapshot is unavailable.' },
};

const canStart = (status: ServiceHealthStatus) => status === 'stopped' || status === 'failed' || status === 'exited';
const canStop = (status: ServiceHealthStatus) => status === 'running' || status === 'starting';

export function ServiceHealthDashboard({
  projects, lifecycle, loading = false, loadError, busyServiceKeys = [], busyProjectIds = [],
  actionByKey, projectActionById, actions,
}: ServiceHealthDashboardProps) {
  const [search, setSearch] = useState('');
  const summary = useMemo(() => summarizeServiceHealth(projects, lifecycle), [
    projects, lifecycle.runningKeys, lifecycle.startingKeys, lifecycle.stoppingKeys,
    lifecycle.serviceErrors, lifecycle.serviceExits,
    lifecycle.healthSnapshots,
  ]);
  const visibleProjects = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query ? summary.projects.filter(item => item.project.name.toLocaleLowerCase().includes(query)) : summary.projects;
  }, [search, summary.projects]);
  const busyServices = useMemo(() => new Set(busyServiceKeys), [busyServiceKeys]);
  const busyProjects = useMemo(() => new Set(busyProjectIds), [busyProjectIds]);

  return (
    <section className="service-health" aria-labelledby="service-health-title">
      <header className="service-health__header">
        <div>
          <span className="service-health__eyebrow">DEVFLOW / PROJECT SERVICES</span>
          <h2 id="service-health-title">Service health</h2>
          <p>Process state for configured development services. Running does not mean an HTTP endpoint is ready.</p>
        </div>
        <label className="service-health__search">
          <span>Find project</span>
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search projects" disabled={loading || projects.length === 0} />
        </label>
      </header>

      {loadError && <p className="service-health__notice service-health__notice--error" role="alert">Could not load project health: {loadError}</p>}
      {loading ? <p className="service-health__notice" role="status">Loading project services…</p> : <>
        <div className="service-health__overview" aria-label="Project service counts">
          <div className="service-health__metric"><strong>{summary.projectCount}</strong><span>Imported projects</span></div>
          <div className="service-health__metric"><strong>{summary.serviceCount}</strong><span>Configured services</span></div>
          <div className="service-health__counts">
            {statusOrder.map(status => <span key={status} className={`service-health__count service-health__count--${status}`} title={statusCopy[status].title}><b>{summary.counts[status]}</b>{statusCopy[status].label}</span>)}
          </div>
        </div>

        {summary.projectCount === 0 ? <div className="service-health__empty">No projects imported yet. Import a project and review its service commands before starting anything.</div>
          : visibleProjects.length === 0 ? <div className="service-health__empty">No projects match “{search.trim()}”.</div>
            : <div className="service-health__grid">
              {visibleProjects.map(({ project, services, runningCount }) => {
                const projectAction = projectActionById?.[project.id];
                const projectBusy = busyProjects.has(project.id) || projectAction?.state === 'pending';
                const anyServiceBusy = services.some(item => busyServices.has(item.key) || actionByKey?.[item.key]?.state === 'pending');
                const startable = services.some(item => canStart(item.status));
                const stoppable = services.some(item => canStop(item.status));
                return <article className="service-health__project" key={project.id} aria-labelledby={`service-health-project-${project.id}`}>
                  <div className="service-health__project-head">
                    <div className="service-health__project-title">
                      <h3 id={`service-health-project-${project.id}`}>{project.name}</h3>
                      <span title="Number of processes currently reported running, out of configured services">{runningCount} / {services.length} running</span>
                    </div>
                    {(actions?.onStartAll || actions?.onRequestStopAll) && <div className="service-health__project-actions">
                      {actions.onStartAll && <button type="button" onClick={() => actions.onStartAll?.(project)} disabled={projectBusy || anyServiceBusy || !startable}>Start all</button>}
                      {actions.onRequestStopAll && <button type="button" onClick={() => actions.onRequestStopAll?.(project)} disabled={projectBusy || anyServiceBusy || !stoppable} title="The host app confirms forced termination before stopping">Stop all</button>}
                    </div>}
                  </div>
                  {projectAction && <p className={`service-health__action service-health__action--${projectAction.state}`} role="status">{projectAction.label}</p>}
                  {services.length === 0 ? <p className="service-health__no-services">No services configured for this project.</p> : <ul className="service-health__services">
                    {services.map(item => {
                      const { service, key, status, role, configuredPort, issue, health } = item;
                      const action = actionByKey?.[key];
                      const serviceBusy = busyServices.has(key) || action?.state === 'pending';
                      const statusInfo = statusCopy[status];
                      return <li className="service-health__service" key={service.id}>
                        <div className="service-health__service-main">
                          <div className="service-health__service-identity"><strong>{service.name}</strong><span>{role}</span></div>
                          <span className={`service-health__status service-health__status--${status}`} title={statusInfo.title} aria-label={`${service.name}: ${statusInfo.title}`}><i aria-hidden="true" />{statusInfo.label}</span>
                        </div>
                        <div className="service-health__service-meta">
                          <span title={service.cwd}>Directory: <code>{service.cwd}</code></span>
                          <span>{configuredPort === null ? 'Port: unknown' : `Configured port: ${configuredPort}`}</span>
                          {status === 'running' && <span>HTTP: {health?.status === 'healthy' ? `Healthy${health.statusCode ? ` · ${health.statusCode}` : ''}${health.responseMs === undefined ? '' : ` · ${health.responseMs} ms`}` : health?.status === 'unhealthy' ? `Unhealthy${health.error ? ` · ${health.error}` : ''}` : health?.status === 'checking' ? 'Checking' : health?.status === 'disabled' ? 'Disabled' : 'Unknown'}</span>}
                        </div>
                        {issue && <p className="service-health__issue" role="alert">{issue}</p>}
                        {action && <p className={`service-health__action service-health__action--${action.state}`} role="status">{action.label}</p>}
                        {(actions?.onStart || actions?.onRequestStop || actions?.onRequestRestart) && <div className="service-health__service-actions">
                          {actions.onStart && <button type="button" onClick={() => actions.onStart?.(project, service)} disabled={projectBusy || serviceBusy || !canStart(status)}>Start</button>}
                          {actions.onRequestStop && <button type="button" onClick={() => actions.onRequestStop?.(project, service)} disabled={projectBusy || (serviceBusy && status !== 'starting') || !canStop(status)} title="The host app confirms forced termination before stopping">Stop</button>}
                          {actions.onRequestRestart && <button type="button" onClick={() => actions.onRequestRestart?.(project, service)} disabled={projectBusy || serviceBusy || status !== 'running'} title="The host app confirms forced restart">Restart</button>}
                        </div>}
                      </li>;
                    })}
                  </ul>}
                </article>;
              })}
            </div>}
      </>}
    </section>
  );
}
