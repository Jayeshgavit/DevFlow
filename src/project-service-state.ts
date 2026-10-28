import type { Project } from './types';
import { serviceKey } from './types';

export type ProjectServiceState = {
  projectId: string;
  status: 'Stopped' | 'Starting' | 'Stopping' | 'Running' | 'Partial' | 'Error';
  active: boolean;
  pending: boolean;
  errors: string[];
};

export function projectServiceState(project: Project, running: string[], starting: string[], stopping: string[], errors: Record<string, string>, backendStopping: string[] = []): ProjectServiceState {
  const keys = project.services.map(service => serviceKey(project.id, service.id));
  const count = keys.filter(key => running.includes(key)).length;
  const launching = keys.some(key => starting.includes(key));
  // A failed cleanup stays in Rust's registry for a safe retry. Only an in-flight
  // request (or cleanup without a reported failure) should disable Stop All.
  const pending = launching || keys.some(key => stopping.includes(key) || (backendStopping.includes(key) && !errors[key]));
  const issues = project.services.flatMap(service => {
    const issue = errors[serviceKey(project.id, service.id)];
    return issue ? [`${service.name}: ${issue}`] : [];
  });
  return { projectId: project.id, active: count > 0 || pending, pending, errors: issues,
    status: launching ? 'Starting' : pending ? 'Stopping' : issues.length ? count > 0 ? 'Partial' : 'Error' : count > 0 ? count === keys.length ? 'Running' : 'Partial' : 'Stopped' };
}

// All entry points use the same destructive confirmation and bulk runner.
export function stopAllConfirmation(project: Project, action: () => void) {
  return { title: `Stop all services in ${project.name}?`, description: 'Windows force stops each running or starting process tree. Unsaved work in those processes could be lost.', confirmText: 'Force stop all', destructive: true, action };
}

export function stopScopeConfirmation(project: Project, scope: 'frontend' | 'backend' | 'both' | 'all', services: { name: string }[], action: () => void) {
  const scopeLabel = scope === 'all' ? 'all services' : scope === 'both' ? 'frontend and backend services' : `${scope} services`;
  return {
    title: `Stop ${scopeLabel} in ${project.name}?`,
    description: `Stop ${services.map(s => s.name).join(', ')}. Only DevFlow-owned process trees will be terminated. Unsaved process work could be lost.`,
    confirmText: `Stop ${scopeLabel}`,
    destructive: true,
    action,
  };
}
