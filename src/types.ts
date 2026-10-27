export type RunOption = { id: string; label: string; program: string; args: string[]; verified: boolean; source: string; explanation: string; interpreterPath?: string; entryPoint?: string };
export type ServiceHealthConfig = { enabled: boolean; host: string; port?: number; path: string; intervalSeconds: number; timeoutSeconds: number; expectedStatusMin: number; expectedStatusMax: number };
export type HealthStatus = 'checking' | 'healthy' | 'unhealthy' | 'unknown' | 'disabled' | 'notApplicable';
export type HealthSnapshot = { status: HealthStatus; checkedAt?: number; statusCode?: number; responseMs?: number; error?: string };
export type Service = { id: string; name: string; cwd: string; program: string; args: string[]; role?: string; framework?: string; host?: string; port?: number; reviewNote?: string; interpreterPath?: string; entryPoint?: string; confidence?: 'high' | 'medium' | 'low'; runOptions?: RunOption[]; healthCheck?: ServiceHealthConfig };
export type Project = { id: string; name: string; root: string; services: Service[] };
export type LogLine = { projectId: string; serviceId: string; stream: string; message: string; receivedAt?: number; incidentId?: string; systemSeverity?: 'info' | 'success' | 'warning' | 'error'; runId?: string; sequence?: number };
export type ServiceLogBatch = { projectId: string; serviceId: string; stream: string; runId: string; lines: { message: string; sequence: number; receivedAt: number }[] };
export type ServiceExit = { projectId: string; serviceId: string; exitCode: number | null; status: string; stopRequested: boolean; runId?: string };
export type View = 'overview' | 'projects' | 'logs' | 'editor' | 'system' | 'maintenance' | 'settings';
export type Theme = 'light' | 'dark' | 'system';

export const serviceKey = (projectId: string, serviceId: string) => `${projectId}::${serviceId}`;
