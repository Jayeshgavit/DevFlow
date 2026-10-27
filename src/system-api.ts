import { invoke } from '@tauri-apps/api/core';

export type SystemProcess = {
  pid: number; name: string; path: string | null; created: string | null;
  cpu: number | null; memory: number | null; denyReason: string | null;
};
export type SystemSnapshot = {
  sampledAt: number; cpu: number | null; cpuName: string; logicalProcessors: number;
  memoryTotal: number; memoryAvailable: number; uptimeSeconds: number;
  processes: SystemProcess[];
  drives: { name: string; total: number | null; free: number | null; error: string | null }[];
  drivesAgeSeconds: number; drivesError: string | null;
  gpus: { name: string; utilization: number | null; dedicatedUsed: number | null; dedicatedTotal: number | null; sharedUsed: number | null; sharedTotal: number | null; note: string | null }[];
  gpuError: string | null;
};
export type CleanupCategory = { id: string; name: string; description: string; safety: string; status: 'supported' | 'unsupported' | 'managed'; candidateCount: number; bytes: number; root: string | null; ageDays: number | null; note: string | null };
export type TempPreview = { id: string; root: string; files: { id: number; path: string; bytes: number }[]; skipped: number; limited: boolean; ageDays: number; categories: CleanupCategory[] };
export type CleanupResult = { removed: number; bytesRemoved: number; skipped: number; cancelled: boolean; details: string[] };

// Deliberately fixed IPC surface: no arbitrary program, command line, or deletion path.
export const systemApi = {
  snapshot: (forceHardware: boolean) => invoke<SystemSnapshot>('system_snapshot', { forceHardware }),
  endTask: (process: SystemProcess) => invoke<string>('system_end_task', { pid: process.pid, created: process.created }),
  scan: () => invoke<TempPreview>('scan_temp_files'),
  clean: (scanId: string, selected: number[]) => invoke<CleanupResult>('clean_temp_files', { scanId, selected }),
  scanCleanup: () => invoke<TempPreview>('scan_cleanup'),
  cleanSelectedCleanup: (scanId: string, categories: string[]) => invoke<CleanupResult>('clean_selected_cleanup', { scanId, categories }),
  cancel: () => invoke<void>('cancel_system_maintenance'),
  flushDns: () => invoke<string>('flush_dns_cache'),
  storage: (tool: 'settings' | 'disk-cleanup') => invoke<string>('open_storage_tool', { tool }),
};
