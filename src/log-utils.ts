import type { LogLine } from './types';

export type LogCategory = 'error' | 'warning' | 'success' | 'info';
export type LogEntry = LogLine & { receivedAt: number };
export type HttpDetails = { method: string; endpoint: string; status: number; durationMs?: number; spans: { start: number; end: number; kind: string }[] };
export type LogGroup = { entries: LogEntry[]; category: LogCategory; http: HttpDetails | null; index: number; searchText: string };

const HTTP_LINE = /["']?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+(\S+?)\s+(?:HTTP\/\d(?:\.\d)?["']?\s+)?([1-5]\d\d)\b/i;
const DURATION = /\b(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds?|s|sec|seconds?)\b/i;
const ERROR_LINE = /\b(error|fatal|panic|exception|traceback|failed|failure)\b|^\s*[A-Za-z_][\w.]*?(?:Error|Exception):/i;
const WARNING_LINE = /\b(warn|warning)\b/i;
const SUCCESS_LINE = /\b(build (?:succeeded|successful|complete|completed)|compiled successfully|built successfully|successfully (?:built|compiled|started)|ready in|server (?:is )?ready|listening on|started server process|application startup complete|✓)\b/i;
const STACK_START = /traceback \(most recent call last\):|exceptiongroup traceback/i;
const STACK_CONTINUATION = /^\s+|^File "|^During handling of the above exception|^The above exception was the direct cause|^ExceptionGroup:|^[A-Za-z_][\w.]*?(?:Error|Exception|Interrupt):/;
const NEW_LOG_LINE = /^(?:\d{4}-\d\d-\d\d[ T]|\[?\d\d?:\d\d(?::\d\d)?|(?:INFO|DEBUG|WARNING|WARN|ERROR|FATAL|TRACE):)/i;

export function parseHttp(message: string): HttpDetails | null {
  const match = HTTP_LINE.exec(message);
  if (!match || match.index === undefined) return null;
  const [full, method, endpoint, statusText] = match;
  const methodStart = match.index + full.indexOf(method);
  const endpointStart = match.index + full.indexOf(endpoint, methodStart - match.index + method.length);
  const statusStart = match.index + full.lastIndexOf(statusText);
  const spans = [
    { start: methodStart, end: methodStart + method.length, kind: 'method' },
    { start: endpointStart, end: endpointStart + endpoint.length, kind: 'endpoint' },
    { start: statusStart, end: statusStart + statusText.length, kind: Number(statusText) < 300 ? 'status-success' : Number(statusText) < 400 ? 'status-redirect' : Number(statusText) < 500 ? 'status-client-error' : 'status-server-error' },
  ];
  const duration = DURATION.exec(message);
  let durationMs: number | undefined;
  if (duration?.index !== undefined) {
    durationMs = /^(?:ms|msec|millisecond)/i.test(duration[2]) ? Number(duration[1]) : Number(duration[1]) * 1000;
    spans.push({ start: duration.index, end: duration.index + duration[0].length, kind: 'duration' });
  }
  return { method, endpoint, status: Number(statusText), durationMs, spans: spans.sort((a, b) => a.start - b.start) };
}

export function classifyLog(message: string, http = parseHttp(message)): LogCategory {
  if (http) return http.status < 300 ? 'success' : http.status < 400 ? 'info' : http.status < 500 ? 'warning' : 'error';
  if (ERROR_LINE.test(message)) return 'error';
  if (WARNING_LINE.test(message)) return 'warning';
  if (SUCCESS_LINE.test(message)) return 'success';
  return 'info';
}

export function summarizeGroups(groups: LogGroup[]) {
  const counts: Record<LogCategory, number> = { error: 0, warning: 0, success: 0, info: 0 };
  let entries = 0;
  let requests = 0;
  groups.forEach(group => {
    counts[group.category] += group.entries.length;
    entries += group.entries.length;
    if (group.http) requests += 1;
  });
  return { entries, requests, counts };
}

export function groupLogs(entries: LogEntry[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (let index = 0; index < entries.length;) {
    const first = entries[index];
    const grouped = STACK_START.test(first.message);
    const rows = [first];
    if (grouped) {
      let cursor = index + 1;
      while (cursor < entries.length) {
        const next = entries[cursor];
        if (next.projectId !== first.projectId || next.serviceId !== first.serviceId || NEW_LOG_LINE.test(next.message)) break;
        if (!STACK_CONTINUATION.test(next.message)) break;
        rows.push(next);
        cursor += 1;
      }
      index = cursor;
    } else index += 1;
    const combined = rows.map(row => row.message).join('\n');
    const http = rows.length === 1 ? parseHttp(first.message) : null;
    groups.push({ entries: rows, category: classifyLog(combined, http), http, index: groups.length, searchText: `${rows[0].serviceId} ${rows.map(entry => `${entry.stream} ${entry.message}`).join('\n')}`.toLocaleLowerCase() });
  }
  return groups;
}

export function serviceGroup(service: { id: string; name: string; role?: string }): 'frontend' | 'backend' | null {
  const identity = `${service.id} ${service.name}`.toLowerCase();
  const role = 'role' in service && typeof service.role === 'string' ? service.role.toLowerCase() : '';
  if (/^(frontend|front-end|client|web|ui)$/.test(role) || /\b(frontend|front-end|client|web|ui)\b/.test(service.id.toLowerCase())) return 'frontend';
  if (/^(backend|back-end|server|api)$/.test(role) || /\b(backend|back-end|server|api)\b/.test(service.id.toLowerCase())) return 'backend';
  if (/\b(frontend|front-end|client|web|ui)\b/.test(identity)) return 'frontend';
  if (/\b(backend|back-end|server|api)\b/.test(identity)) return 'backend';
  return null;
}

export function formatEntry(entry: LogEntry, serviceName: string): string {
  const timestamp = new Date(entry.receivedAt).toLocaleString();
  return `[${timestamp}] [${serviceName}] [${entry.stream}] ${entry.message}`;
}

export function redactForAiPrompt(value: string): string {
  return value
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(\b(?:authorization)\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(\b(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTH_TOKEN)|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-key|access-token|refresh-token|password|passwd|secret|token)(?:=|\s+))("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}

export function buildAiDebugPrompt(project: { name: string; root: string }, services: Array<{ id: string; name: string; cwd: string; program: string; args: string[]; role?: string }>, entries: LogEntry[]): string {
  const serviceIds = new Set(entries.map(entry => entry.serviceId));
  const relevantServices = services.filter(service => serviceIds.has(service.id));
  const serviceInfo = relevantServices.map(service => [
    `### ${service.name} (${service.role || service.id})`,
    `Working directory: ${redactForAiPrompt(service.cwd)}`,
    `Command: ${redactForAiPrompt([service.program, ...service.args].join(' '))}`,
  ].join('\n')).join('\n\n');
  const logText = entries.map(entry => formatEntry({ ...entry, message: redactForAiPrompt(entry.message) }, services.find(service => service.id === entry.serviceId)?.name || entry.serviceId)).join('\n');
  return [`Help debug this local development project. Sensitive values may still appear; the masking below is best effort, so review before sharing.`, `Project: ${redactForAiPrompt(project.name)}`, `Project root: ${redactForAiPrompt(project.root)}`, '', '## Relevant services', serviceInfo || 'No configured service metadata was available.', '', '## Logs', logText || 'No matching logs available.'].join('\n');
}
