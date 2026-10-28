import type { ApiRequest, Pair } from './api-tester-api';
import type { Service } from './types';

export const newId = () => crypto.randomUUID();
export const pair = (): Pair => ({ id: newId(), enabled: true, key: '', value: '', secret: false });
export const blankRequest = (): ApiRequest => ({ method: 'GET', url: '', params: [], headers: [], bodyMode: 'none', body: '', form: [], bodySecret: true, auth: 'none', token: '', username: '', password: '', timeoutSeconds: 30 });
export const sensitiveKey = (key: string) => /auth|token|secret|password|passwd|cookie|api[-_]?key|credential|session|signature/i.test(key);
export function validateRequest(request: ApiRequest): string {
  let url: URL;
  try { url = new URL(request.url); } catch { return 'Enter a complete HTTP(S) loopback URL, including the port when needed.'; }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash || /[\x00-\x20]/.test(request.url)) return 'Use localhost, 127.0.0.1, or [::1] over HTTP(S), without credentials, spaces, or fragments.';
  if (request.url.length > 8192) return 'URL exceeds 8 KiB.';
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 120) return 'Timeout must be a whole number from 1 to 120 seconds.';
  if (new TextEncoder().encode(JSON.stringify(request)).length > 256 * 1024) return 'Request exceeds the 256 KiB limit.';
  if (request.bodyMode === 'json') {
    try { JSON.parse(request.body); } catch { return 'Invalid JSON body. Check quoted keys, commas, and matching brackets.'; }
  }
  const names = new Set<string>();
  for (const header of request.headers.filter(h => h.enabled && h.key)) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(header.key) || /[^\t\x20-\x7e\x80-\xff]/.test(header.value)) return 'Malformed header: names cannot contain spaces; values cannot contain line breaks or control characters.';
    const name = header.key.toLowerCase();
    if (names.has(name)) return 'Duplicate enabled headers are ambiguous. Combine them into one row.';
    if (['host', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization', 'proxy-connection', 'upgrade', 'trailer'].includes(name)) return 'Host, framing, connection, and proxy headers are managed by the HTTP client.';
    names.add(name);
  }
  if (names.has('authorization') && ['bearer', 'basic'].includes(request.auth)) return 'Choose either the Auth tab or an Authorization header.';
  if (request.auth === 'bearer' && !request.token) return 'Enter a session-only Bearer token.';
  if (request.auth === 'bearer' && /[\s\x00-\x1f\x7f]/.test(request.token)) return 'Bearer token cannot contain whitespace or control characters.';
  if (request.auth === 'basic' && (!request.username || request.username.includes(':'))) return 'Enter a session-only Basic username without a colon.';
  const missing = [...request.params, ...request.headers, ...(request.bodyMode === 'form' ? request.form : [])].find(row => row.enabled && row.key && (row.secret || sensitiveKey(row.key)) && !row.value);
  if (missing) return 'Fill session-only values or disable their rows before sending.';
  return '';
}
// Only actual configured host and port fields are used. Wildcard bind hosts do
// not identify a connection destination and are intentionally not guessed.
export function serviceEndpoint(service: Service): string | null {
  const health = service.healthCheck;
  const port = health?.port ?? service.port;
  const host = health?.host || service.host;
  if (!host || !port || !Number.isInteger(port) || port < 1 || port > 65535 || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) return null;
  const authority = host === '::1' ? '[::1]' : host;
  const path = health?.path || '/';
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path)) return null;
  return `http://${authority}:${port}${path}`;
}
/** Defense in depth before IPC; Rust independently enforces persistence rules. */
export function persistedRequest(input: ApiRequest, history = false): ApiRequest {
  const result: ApiRequest = JSON.parse(JSON.stringify(input));
  result.token = ''; result.username = ''; result.password = '';
  try {
    const url = new URL(result.url);
    const keys = [...url.searchParams.keys()]; url.search = '';
    keys.forEach(key => url.searchParams.append(key, '')); result.url = url.href;
  } catch { /* Backend rejects malformed saved URLs. */ }
  for (const row of [...result.params, ...result.headers, ...result.form]) {
    if (history || row.secret || sensitiveKey(row.key)) { row.value = ''; row.secret = true; }
  }
  if (result.auth === 'headers') for (const header of result.headers) { header.value = ''; header.secret = true; }
  if (history || result.bodySecret) { result.body = ''; result.bodySecret = true; }
  return result;
}
