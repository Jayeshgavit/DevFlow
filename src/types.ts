export type Service = { id: string; name: string; cwd: string; program: string; args: string[]; role?: string };
export type Project = { id: string; name: string; root: string; services: Service[] };
export type LogLine = { projectId: string; serviceId: string; stream: string; message: string; receivedAt?: number };
export type View = 'overview' | 'projects' | 'logs' | 'settings';
export type Theme = 'light' | 'dark' | 'system';

export const serviceKey = (projectId: string, serviceId: string) => `${projectId}::${serviceId}`;
