import type { HealthSnapshot, Project, Service, ServiceExit } from './types';
import { serviceKey } from './types';

export type ServiceHealthStatus = 'running' | 'starting' | 'stopping' | 'stopped' | 'failed' | 'exited' | 'unknown';
export type ServiceHealthRole = 'frontend' | 'backend' | 'other';
export type ServiceHealthCounts = Record<ServiceHealthStatus, number>;

export type ServiceHealthState = {
  /** null means the backend running-service snapshot is unavailable or has not arrived. */
  runningKeys: readonly string[] | null;
  startingKeys?: readonly string[];
  stoppingKeys?: readonly string[];
  serviceErrors?: Readonly<Record<string, string>>;
  serviceExits?: Readonly<Record<string, ServiceExit>>;
  healthSnapshots?: Readonly<Record<string, HealthSnapshot>>;
};

export type ServiceHealthItem = {
  key: string;
  service: Service;
  status: ServiceHealthStatus;
  role: ServiceHealthRole;
  configuredPort: number | null;
  issue: string | null;
  health?: HealthSnapshot;
};

export type ServiceHealthProject = {
  project: Project;
  services: ServiceHealthItem[];
  runningCount: number;
};

export type ServiceHealthSummary = {
  projectCount: number;
  serviceCount: number;
  counts: ServiceHealthCounts;
  projects: ServiceHealthProject[];
};

const emptyCounts = (): ServiceHealthCounts => ({
  running: 0, starting: 0, stopping: 0, stopped: 0,
  failed: 0, exited: 0, unknown: 0,
});

/** Mirrors the explicit --port forms parsed by Rust's launcher, without claiming a listener exists. */
export function configuredServicePort(args: readonly string[]): number | null {
  let port: number | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = argument === '--port' ? args[++index] : argument.startsWith('--port=') ? argument.slice(7) : null;
    if (value === null) continue;
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || port !== null) return null;
    port = parsed;
  }
  return port;
}

export function serviceHealthRole(service: Service): ServiceHealthRole {
  const role = service.role?.trim().toLowerCase();
  if (role === 'frontend' || role === 'backend') return role;
  if (role === 'other') return 'other';
  // These IDs are assigned by DevFlow's existing frontend/backend/client/server detector.
  if (service.id === 'frontend' || service.id === 'client') return 'frontend';
  if (service.id === 'backend' || service.id === 'server') return 'backend';
  return 'other';
}

export function summarizeServiceHealth(projects: readonly Project[], state: ServiceHealthState): ServiceHealthSummary {
  const running = state.runningKeys === null ? null : new Set(state.runningKeys);
  const starting = new Set(state.startingKeys ?? []);
  const stopping = new Set(state.stoppingKeys ?? []);
  const counts = emptyCounts();
  let serviceCount = 0;
  const projectSummaries = projects.map(project => {
    let runningCount = 0;
    const services = project.services.map(service => {
      const key = serviceKey(project.id, service.id);
      const exit = state.serviceExits?.[key];
      const error = state.serviceErrors?.[key];
      let status: ServiceHealthStatus;
      if (stopping.has(key)) status = 'stopping';
      else if (starting.has(key)) status = 'starting';
      else if (running === null) status = 'unknown';
      else if (running?.has(key)) status = 'running';
      else if (error) status = 'failed';
      else if (exit) status = exit.stopRequested ? 'stopped' : exit.exitCode === 0 ? 'exited' : 'failed';
      else status = 'stopped';

      const issue = error ? error
        : exit && !exit.stopRequested ? `Last reported exit: ${exit.status}`
          : null;
      counts[status] += 1;
      serviceCount += 1;
      if (status === 'running') runningCount += 1;
      return { key, service, status, role: serviceHealthRole(service), configuredPort: configuredServicePort(service.args), issue, health: state.healthSnapshots?.[key] };
    });
    return { project, services, runningCount };
  });
  return { projectCount: projects.length, serviceCount, counts, projects: projectSummaries };
}
