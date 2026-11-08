import type { LogLine } from './types';

export type LogCategory = 'error' | 'warning' | 'success' | 'info';
export type AnsiColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'bright-black' | 'bright-red' | 'bright-green' | 'bright-yellow' | 'bright-blue' | 'bright-magenta' | 'bright-cyan' | 'bright-white';
export type AnsiStyle = { bold: boolean; foreground?: AnsiColor; background?: AnsiColor };
export type AnsiSpan = { start: number; end: number; style: AnsiStyle };
export type LogEntry = LogLine & { receivedAt: number; ansiSpans?: AnsiSpan[] };
export type HttpDetails = { method: string; endpoint: string; status: number; durationMs?: number; spans: { start: number; end: number; kind: string }[] };
export type LogGroup = { entries: LogEntry[]; category: LogCategory; http: HttpDetails | null; index: number; searchText: string; repeatCount: number; sample: LogEntry[]; latestAt: number };
export const MAX_SERVICE_LOGS = 10000;
export const MAX_PROJECT_LOGS = 20000;
export const MAX_SESSION_LOGS = 40000;
export const MAX_SERVICE_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_LOG_BYTES = 32 * 1024 * 1024;
// Conservative charge includes UTF-16 text, cached search text and ANSI spans.
export const logBytes = (entry: LogEntry) => 512 + entry.message.length * 6 + (entry.ansiSpans?.length || 0) * 128;

export function appendLog(current: LogEntry[], entry: LogEntry): LogEntry[] {
  return appendLogs(current, [entry]);
}

export function appendLogs(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const next = [...current, ...incoming];
  const services = new Map<string, { count: number; bytes: number }>();
  const projects = new Map<string, { count: number; bytes: number }>();
  const kept: LogEntry[] = []; let total = 0;
  // Once a scope reaches its budget, expire its older prefix, never holes in a traceback.
  const fullServices = new Set<string>(), fullProjects = new Set<string>();
  for (let index = next.length - 1; index >= 0 && kept.length < MAX_SESSION_LOGS; index--) {
    const line = next[index], key = `${line.projectId}\0${line.serviceId}`, bytes = logBytes(line);
    const service = services.get(key) || { count: 0, bytes: 0 }, project = projects.get(line.projectId) || { count: 0, bytes: 0 };
    if (total + bytes > MAX_SESSION_LOG_BYTES) break;
    if (fullProjects.has(line.projectId) || fullServices.has(key)) continue;
    if (project.count >= MAX_PROJECT_LOGS || project.bytes + bytes > MAX_PROJECT_LOG_BYTES) { fullProjects.add(line.projectId); continue; }
    if (service.count >= MAX_SERVICE_LOGS || service.bytes + bytes > MAX_SERVICE_LOG_BYTES) { fullServices.add(key); continue; }
    service.count++; service.bytes += bytes; project.count++; project.bytes += bytes; total += bytes;
    services.set(key, service); projects.set(line.projectId, project); kept.push(line);
  }
  return kept.reverse();
}

export function createSourceDeduper() {
  const latest = new Map<string, number>();
  return (entry: LogLine) => {
    if (!entry.runId || entry.sequence === undefined) return true;
    const key = `${entry.projectId}\0${entry.serviceId}\0${entry.runId}\0${entry.stream}`;
    if (entry.sequence <= (latest.get(key) ?? 0)) return false;
    latest.delete(key); latest.set(key, entry.sequence);
    if (latest.size > 256) latest.delete(latest.keys().next().value!);
    return true;
  };
}

const HTTP_LINE = /["']?(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+(\S+?)\s+(?:HTTP\/\d(?:\.\d)?["']?\s+)?([1-5]\d\d)\b/i;
const DURATION = /\b(\d+(?:\.\d+)?)\s*(ms|msec|milliseconds?|s|sec|seconds?)\b/i;
const ERROR_LINE = /\b(error|fatal|panic|exception|traceback|failed|failure)\b|^\s*[A-Za-z_][\w.]*?(?:Error|Exception):/i;
const WARNING_LINE = /\b(warn|warning)\b/i;
const SUCCESS_LINE = /\b(build (?:succeeded|successful|complete|completed)|compiled successfully|built successfully|successfully (?:built|compiled|started)|ready in|server (?:is )?ready|listening on|started server process|application startup complete|✓)\b/i;
const STACK_START = /traceback \(most recent call last\):|exceptiongroup traceback/i;
const STACK_CONTINUATION = /^\s+|^File "|^During handling of the above exception|^The above exception was the direct cause|^ExceptionGroup:|^[A-Za-z_][\w.]*?(?:Error|Exception|Interrupt):/;
const NEW_LOG_LINE = /^(?:\d{4}-\d\d-\d\d[ T]|\[?\d\d?:\d\d(?::\d\d)?|(?:INFO|DEBUG|WARNING|WARN|ERROR|FATAL|TRACE):)/i;
const STACK_FRAME = /^\s*(?:at\s+|File "|\.\.\. \d+ more|Caused by:)/;
const ERROR_HEADER = /^(?:\s*(?:[\w.]+(?:Error|Exception)|Error|Exception)(?::|\b)|.*\b(?:Error|Exception):)/;
const entryAnalysis = new WeakMap<LogEntry, { http: HttpDetails | null; category: LogCategory; searchText: string }>();
const ANSI_COLORS: AnsiColor[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

type AnsiState = AnsiStyle & { pending: string };

function applySgr(state: AnsiState, parameters: string) {
  const codes = (parameters || '0').split(';').map(value => Number(value || 0));
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) { state.bold = false; delete state.foreground; delete state.background; }
    else if (code === 1) state.bold = true;
    else if (code === 22) state.bold = false;
    else if (code === 39) delete state.foreground;
    else if (code === 49) delete state.background;
    else if (code >= 30 && code <= 37) state.foreground = ANSI_COLORS[code - 30];
    else if (code >= 40 && code <= 47) state.background = ANSI_COLORS[code - 40];
    else if (code >= 90 && code <= 97) state.foreground = `bright-${ANSI_COLORS[code - 90]}` as AnsiColor;
    else if (code >= 100 && code <= 107) state.background = `bright-${ANSI_COLORS[code - 100]}` as AnsiColor;
    else if ((code === 38 || code === 48) && (codes[index + 1] === 5 || codes[index + 1] === 2)) index += codes[index + 1] === 5 ? 2 : 4;
  }
}

function decodeAnsiChunk(chunk: string, state: AnsiState): { text: string; spans: AnsiSpan[] } {
  const input = state.pending + chunk;
  state.pending = '';
  let text = '';
  const spans: AnsiSpan[] = [];
  const append = (value: string) => {
    if (!value) return;
    const start = text.length;
    text += value;
    if (!state.bold && !state.foreground && !state.background) return;
    const style = { bold: state.bold, foreground: state.foreground, background: state.background };
    const previous = spans[spans.length - 1];
    if (previous && previous.end === start && previous.style.bold === style.bold && previous.style.foreground === style.foreground && previous.style.background === style.background) previous.end = text.length;
    else spans.push({ start, end: text.length, style });
  };
  for (let index = 0; index < input.length;) {
    const code = input.charCodeAt(index);
    if (code === 0x1b || code === 0x9b) {
      const csiStart = code === 0x9b ? index + 1 : input[index + 1] === '[' ? index + 2 : -1;
      if (csiStart >= 0) {
        let final = csiStart;
        while (final < input.length && input.charCodeAt(final) >= 0x20 && input.charCodeAt(final) <= 0x3f) final += 1;
        if (final >= input.length) { state.pending = input.slice(index); break; }
        if (input[final] === 'm') applySgr(state, input.slice(csiStart, final));
        index = final + 1;
        continue;
      }
      if (code === 0x1b && [']', 'P', 'X', '^', '_'].includes(input[index + 1])) {
        const bell = input.indexOf('\x07', index + 2);
        const terminator = input.indexOf('\x1b\\', index + 2);
        const end = bell < 0 ? terminator : terminator < 0 ? bell : Math.min(bell, terminator);
        if (end < 0) { state.pending = input.slice(index); break; }
        index = end + (end === terminator ? 2 : 1);
        continue;
      }
      if (code === 0x1b && index + 1 >= input.length) { state.pending = input.slice(index); break; }
      index += code === 0x1b ? 2 : 1;
      continue;
    }
    let end = index;
    while (end < input.length) {
      const value = input.charCodeAt(end);
      if (value === 0x1b || value === 0x9b || (value < 0x20 && value !== 0x09 && value !== 0x0a)) break;
      end += 1;
    }
    if (end > index) { append(input.slice(index, end)); index = end; }
    else index += 1;
  }
  if (state.pending.length > 4096) state.pending = '';
  return { text, spans };
}

export function createAnsiLogNormalizer() {
  const states = new Map<string, AnsiState>();
  return function normalizeAnsiLog(entry: LogEntry): LogEntry {
    const key = `${entry.projectId}\0${entry.serviceId}\0${entry.runId || ''}\0${entry.stream}`;
    const state = states.get(key) ?? { bold: false, pending: '' };
    states.set(key, state);
    if (states.size > 256) states.delete(states.keys().next().value!);
    const decoded = decodeAnsiChunk(entry.message, state);
    return { ...entry, message: decoded.text, ansiSpans: decoded.spans };
  };
}

export function stripAnsi(value: string): string {
  return decodeAnsiChunk(value, { bold: false, pending: '' }).text;
}

export function findLoopbackUrls(value: string): Array<{ start: number; end: number; url: string }> {
  const matches = value.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[^\s<>"']*)?/gi);
  return Array.from(matches, match => {
    const url = match[0].replace(/[),.;!?]+$/, '');
    return { start: match.index!, end: match.index! + url.length, url };
  }).filter(match => {
    try {
      const parsed = new URL(match.url);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
    } catch { return false; }
  });
}

function analyzeEntry(entry: LogEntry) {
  let result = entryAnalysis.get(entry);
  if (!result) {
    const http = entry.incidentId ? null : parseHttp(entry.message);
    result = { http, category: entry.incidentId && entry.systemSeverity ? entry.systemSeverity : classifyLog(entry.message, http), searchText: `${entry.serviceId} ${entry.stream} ${entry.message}`.toLocaleLowerCase() };
    entryAnalysis.set(entry, result);
  }
  return result;
}

export function parseHttp(message: string): HttpDetails | null {
  const match = HTTP_LINE.exec(message);
  if (!match || match.index === undefined) return null;
  const [full, method, endpoint, statusText] = match;
  if (!endpoint.startsWith('/') && !/^https?:\/\//i.test(endpoint)) return null;
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
    if (group.http) requests += group.repeatCount;
  });
  return { entries, requests, counts };
}

export function groupLogs(entries: LogEntry[]): LogGroup[] {
  const groups: LogGroup[] = [];
  for (let index = 0; index < entries.length;) {
    const first = entries[index];
    const pythonStack = STACK_START.test(first.message);
    const grouped = !first.incidentId && (pythonStack || ERROR_HEADER.test(first.message));
    const rows = [first];
    if (grouped) {
      let cursor = index + 1;
      while (cursor < entries.length) {
        const next = entries[cursor];
        if (next.projectId !== first.projectId || next.serviceId !== first.serviceId || next.stream !== first.stream || NEW_LOG_LINE.test(next.message)) break;
        // A new exception is independent unless the traceback syntax links it.
        if (pythonStack ? !STACK_CONTINUATION.test(next.message) : !STACK_FRAME.test(next.message)) break;
        rows.push(next);
        cursor += 1;
        if (pythonStack && /^[A-Za-z_][\w.]*(?:Error|Exception|Interrupt):?/.test(next.message)) {
          // End at the terminal exception unless Python explicitly links a cause.
          const linked = entries[cursor];
          if (!linked || !/^During handling of the above exception|^The above exception was the direct cause/.test(linked.message)) break;
        }
      }
      index = cursor;
    } else index += 1;
    const analysis = analyzeEntry(first);
    const http = rows.length === 1 ? analysis.http : null;
    const category = rows.length > 1 ? 'error' : analysis.category;
    const previous = groups[groups.length - 1];
    if (category === 'error' && previous?.category === 'error' && !first.incidentId
      && previous.sample.length === rows.length && previous.sample.every((row, offset) => {
        const next = rows[offset];
        return row.projectId === next.projectId && row.serviceId === next.serviceId && row.stream === next.stream && row.runId === next.runId && row.message === next.message;
      })) {
      previous.entries.push(...rows); previous.repeatCount++; previous.latestAt = first.receivedAt;
    } else groups.push({ entries: rows.slice(), sample: rows, repeatCount: 1, latestAt: first.receivedAt, category, http, index: groups.length, searchText: rows.map(row => analyzeEntry(row).searchText).join('\n') });
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

export type LogStopScope = 'frontend' | 'backend' | 'both' | 'all';
export function logStopServices<T extends { id: string; name: string; role?: string }>(services: T[], scope: LogStopScope): T[] {
  return services.filter(service => scope === 'all' || (scope === 'both' ? serviceGroup(service) !== null : serviceGroup(service) === scope));
}

export function buildServiceOptions<T extends { id: string; name: string; role?: string }>(services: T[]): { value: string; label: string }[] {
  const seen = new Set<string>();
  const list: T[] = [];
  for (const service of services) {
    if (service.id && !seen.has(service.id)) {
      seen.add(service.id);
      list.push(service);
    }
  }
  const frontendServices = list.filter(s => serviceGroup(s) === 'frontend');
  const backendServices = list.filter(s => serviceGroup(s) === 'backend');
  const nameCounts = new Map<string, number>();
  for (const s of list) {
    nameCounts.set(s.name, (nameCounts.get(s.name) || 0) + 1);
  }
  const options: { value: string; label: string }[] = [
    { value: 'all', label: 'Combined services' }
  ];
  if (frontendServices.length > 1) {
    options.push({ value: 'role:frontend', label: `Frontend (all ${frontendServices.length})` });
  }
  if (backendServices.length > 1) {
    options.push({ value: 'role:backend', label: `Backend (all ${backendServices.length})` });
  }
  for (const service of list) {
    const isDuplicateName = (nameCounts.get(service.name) || 0) > 1;
    const label = isDuplicateName ? `${service.name} (${service.id})` : service.name;
    options.push({ value: service.id, label });
  }
  return options;
}

export function remapServiceFilter<T extends { id: string; name: string; role?: string }>(filter: string, services: T[]): string {
  if (filter === 'all') return 'all';
  const seen = new Set<string>();
  const list: T[] = [];
  for (const service of services) {
    if (service.id && !seen.has(service.id)) {
      seen.add(service.id);
      list.push(service);
    }
  }
  const frontendServices = list.filter(s => serviceGroup(s) === 'frontend');
  const backendServices = list.filter(s => serviceGroup(s) === 'backend');
  if (filter === 'role:frontend') {
    if (frontendServices.length === 0) return 'all';
    if (frontendServices.length === 1) return frontendServices[0].id;
    return 'role:frontend';
  }
  if (filter === 'role:backend') {
    if (backendServices.length === 0) return 'all';
    if (backendServices.length === 1) return backendServices[0].id;
    return 'role:backend';
  }
  const exists = list.some(s => s.id === filter);
  return exists ? filter : 'all';
}

export type LogCopyKind = 'all' | 'frontend' | 'backend' | 'errors' | 'frontend-errors' | 'backend-errors' | 'current';
export function logCopyGroups(project: { id: string; services: { id: string; name: string; role?: string }[] }, groups: LogGroup[], filtered: LogGroup[], kind: LogCopyKind): LogGroup[] {
  const source = kind === 'current' ? filtered : groups;
  const role = kind.includes('frontend') ? 'frontend' : kind.includes('backend') ? 'backend' : null;
  const serviceIds = role ? new Set(project.services.filter(service => serviceGroup(service) === role).map(service => service.id)) : null;
  return source.filter(group => group.entries.every(entry => entry.projectId === project.id || (!entry.projectId && !!entry.incidentId))
    && (!serviceIds || serviceIds.has(group.entries[0].serviceId))
    && (!(kind === 'errors' || kind.endsWith('-errors')) || group.category === 'error'));
}

export function formatEntry(entry: LogEntry, serviceName: string): string {
  const timestamp = new Date(entry.receivedAt).toLocaleString();
  return `[${timestamp}] [${serviceName}] [${entry.stream}] ${stripAnsi(entry.message)}`;
}

export function redactForSharing(value: string): string {
  return stripAnsi(value)
    .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'))
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(\b(?:authorization)["']?\s*[:=]\s*["']?)(?:bearer|basic)\s+[^\s,;"']+/gi, '$1[redacted]')
    .replace(/(\b(?:cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, '$1[redacted]')
    .replace(/(\b(?:[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTH_TOKEN)|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?!\[redacted\])[^\s,;&"'\]}]+)/gi, '$1[redacted]')
    .replace(/(--(?:api-key|access-token|refresh-token|password|passwd|secret|token)(?:=|\s+))("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}
export const redactForAiPrompt = redactForSharing;

// Explicit absolute Windows locations only. Relative stack paths are ambiguous
// between project and service roots, so they deliberately have no editor action.
export function parseErrorLocation(message: string, root: string): { path: string; line: number } | null {
  const text = stripAnsi(message);
  const match = /(?:File "([A-Za-z]:[\\/][^"\r\n]+)", line (\d+)|(?:\(|^|\s)([A-Za-z]:[\\/][^\r\n]*?):(\d+)(?::\d+)?(?=[\s)]|$))/.exec(text);
  if (!match) return null;
  const absolute = (match[1] || match[3]).replace(/\\/g, '/');
  const base = root.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/$/, '');
  if (!absolute.toLowerCase().startsWith(base.toLowerCase() + '/')) return null;
  const path = absolute.slice(base.length + 1);
  const line = Number(match[2] || match[4]);
  if (!Number.isSafeInteger(line) || line < 1 || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  return { path, line };
}

export function errorContext(entries: LogEntry[], errors: LogEntry[], limit = 200): LogEntry[] {
  const selected = new Set(errors);
  const indices = new Set<number>();
  entries.forEach((entry, index) => {
    if (!selected.has(entry)) return;
    for (let at = Math.max(0, index - 2); at <= Math.min(entries.length - 1, index + 2); at++) {
      const candidate = entries[at];
      if (candidate.projectId === entry.projectId && candidate.serviceId === entry.serviceId && candidate.runId === entry.runId) indices.add(at);
    }
  });
  return [...indices].sort((a, b) => a - b).slice(-limit).map(index => entries[index]);
}

export function buildAiDebugPrompt(project: { name: string; root: string }, services: Array<{ id: string; name: string; cwd: string; program: string; args: string[]; role?: string }>, entries: LogEntry[]): string {
  const serviceIds = new Set(entries.map(entry => entry.serviceId));
  const relevantServices = services.filter(service => serviceIds.has(service.id));
  const serviceInfo = relevantServices.map(service => [
    `### ${redactForSharing(service.name)} (${redactForSharing(service.role || service.id)})`,
    `Working directory: ${redactForSharing(service.cwd)}`,
    `Command: ${redactForSharing([service.program, ...service.args].join(' '))}`,
  ].join('\n')).join('\n\n');
  const logText = entries.map(entry => redactForSharing(formatEntry(entry, services.find(service => service.id === entry.serviceId)?.name || entry.serviceId))).join('\n');
  return [`Help debug this local development project. Sensitive values may still appear; the masking below is best effort, so review before sharing.`, `Project: ${redactForSharing(project.name)}`, `Project root: ${redactForSharing(project.root)}`, '', '## Relevant services', serviceInfo || 'No configured service metadata was available.', '', '## Logs', logText || 'No matching logs available.'].join('\n');
}
