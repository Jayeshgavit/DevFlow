import { errorMessage } from './operation-error';
import type { Service } from './types';
import { serviceKey } from './types';

export type BulkMode = 'start' | 'stop';
export type BulkStep = 'queued' | 'starting' | 'stopping' | 'launched' | 'stopped' | 'skipped' | 'failed';
export type BulkResult = { step: BulkStep; detail: string };

export async function runBulkAction({ mode, projectId, services, getActive, isStarting, isCancelled = () => false, execute, onProgress }: {
  mode: BulkMode;
  projectId: string;
  services: Service[];
  getActive: () => Promise<string[]>;
  isStarting: (key: string) => boolean;
  isCancelled?: (key: string) => boolean;
  execute: (service: Service) => Promise<void>;
  onProgress: (key: string, result: BulkResult) => void;
}): Promise<Record<string, BulkResult>> {
  const results: Record<string, BulkResult> = {};
  const update = (key: string, result: BulkResult) => {
    results[key] = result;
    onProgress(key, result);
  };
  for (const service of services) update(serviceKey(projectId, service.id), { step: 'queued', detail: 'Queued' });

  for (const service of services) {
    const key = serviceKey(projectId, service.id);
    try {
      if (mode === 'start' && isCancelled(key)) { update(key, { step: 'skipped', detail: 'Start cancelled by Stop request' }); continue; }
      const active = (await getActive()).includes(key) || isStarting(key);
      if (mode === 'start' && isCancelled(key)) { update(key, { step: 'skipped', detail: 'Start cancelled by Stop request' }); continue; }
      if (mode === 'start' && active) { update(key, { step: 'skipped', detail: 'Already active' }); continue; }
      if (mode === 'stop' && !active) { update(key, { step: 'skipped', detail: 'Already stopped' }); continue; }
      update(key, { step: mode === 'start' ? 'starting' : 'stopping', detail: mode === 'start' ? 'Starting…' : 'Stopping…' });
      await execute(service);
      update(key, { step: mode === 'start' ? 'launched' : 'stopped', detail: mode === 'start' ? 'Launched' : 'Stopped' });
    } catch (cause) {
      update(key, { step: 'failed', detail: `Failed: ${errorMessage(cause)}` });
    }
  }
  return results;
}
