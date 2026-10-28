import { invoke } from '@tauri-apps/api/core';
import { editorApi } from './editor-api';
import { METHODS, type Method, type ApiRequest } from './api-tester-api';
import { blankRequest, pair, sensitiveKey } from './api-tester-state';
import type { Project } from './types';

type Json = Record<string, any>;
export type Endpoint = { method: Method; path: string; summary: string; description: string; group: string; source: 'OpenAPI' | 'Source'; parameters: Json[]; body?: Json; contentType?: string; document?: Json };
export type SourceDiscovery = { endpoints: Endpoint[]; openapiPaths: string[]; fastapi: boolean; notes: string[] };
const object = (value: any): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const safePath = (path: string) => path.startsWith('/') && !path.startsWith('//') && path.length < 2048 && !/[\\\s?#]/.test(path);
function fastapiArguments(text: string): string | undefined {
  const start = /\bFastAPI\s*\(/.exec(text); if (!start) return undefined;
  let depth = 1; let quote = ''; let escaped = false;
  const from = start.index + start[0].length;
  for (let i = from; i < Math.min(text.length, from + 8192); i++) {
    const char = text[i];
    if (quote) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return text.slice(from, i);
  }
  return undefined;
}
export function resolveSchema(value: any, document: Json, depth = 0): Json {
  if (!object(value) || depth > 8) return {};
  if (typeof value.$ref === 'string') {
    if (!value.$ref.startsWith('#/')) return {};
    let target: any = document;
    for (const key of value.$ref.slice(2).split('/')) { if (!object(target) || !Object.prototype.hasOwnProperty.call(target, key.replace(/~1/g, "/").replace(/~0/g, "~"))) return {}; target = target[key.replace(/~1/g, '/').replace(/~0/g, '~')]; }
    return resolveSchema(target, document, depth + 1);
  }
  return value;
}
export function parseOpenApi(text: string): Endpoint[] {
  const doc = JSON.parse(text);
  if (!object(doc) || typeof doc.openapi !== 'string' || !/^3\.[01]\./.test(doc.openapi) || !object(doc.paths)) throw new Error('Expected an OpenAPI 3.0 or 3.1 JSON document.');
  const result: Endpoint[] = [];
  for (const [path, raw] of Object.entries(doc.paths).slice(0, 1000)) {
    if (!safePath(path)) continue;
    const item = resolveSchema(raw, doc);
    for (const method of METHODS) {
      const operation = item[method.toLowerCase()]; if (!object(operation)) continue;
      const body = resolveSchema(operation.requestBody, doc);
      const content = object(body.content) ? body.content : {};
      const contentType = Object.keys(content).find(key => key === 'application/json' || key.endsWith('+json')) || Object.keys(content)[0];
      result.push({ method, path, summary: String(operation.summary || operation.operationId || '').slice(0, 500), description: String(operation.description || '').slice(0, 4000), group: String(operation.tags?.[0] || 'OpenAPI'), source: 'OpenAPI', parameters: [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])].slice(0, 100).map(p => resolveSchema(p, doc)), body: contentType ? resolveSchema(content[contentType]?.schema, doc) : undefined, contentType, document: doc });
      if (result.length >= 1000) return result;
    }
  }
  return result;
}
function example(raw: Json, doc: Json, depth = 0, key = '', budget = { remaining: 300 }): any {
  if (depth > 6 || budget.remaining-- <= 0) return '<schema limit>';
  if (sensitiveKey(key)) return '<required session value>';
  const schema = resolveSchema(raw, doc);
  const value = schema.default ?? schema.example ?? schema.enum?.[0];
  if (typeof value === 'string') return value.slice(0, 4096);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (schema.type === 'object' || object(schema.properties)) return Object.fromEntries(Object.entries(schema.properties || {}).slice(0, 40).map(([name, value]) => [name, example(value as Json, doc, depth + 1, name, budget)]));
  if (schema.type === 'array') return [example(schema.items || {}, doc, depth + 1, '', budget)];
  return `<required ${schema.type || 'value'}>`;
}
export function prepareEndpoint(endpoint: Endpoint, base: string): ApiRequest {
  const request = blankRequest(); request.method = endpoint.method;
  request.url = base ? new URL(base).origin + endpoint.path : endpoint.path;
  request.params = endpoint.parameters.filter(p => p.in === 'query' && typeof p.name === 'string').map(p => ({ ...pair(), key: p.name, value: sensitiveKey(p.name) ? '' : String(p.example ?? p.schema?.default ?? ''), enabled: !!p.required, secret: sensitiveKey(p.name) }));
  if (endpoint.contentType) request.headers = [{ ...pair(), key: 'Content-Type', value: endpoint.contentType }];
  request.headers.push(...endpoint.parameters.filter(p => p.in === 'header' && typeof p.name === 'string' && p.name.toLowerCase() !== 'content-type').map(p => ({ ...pair(), key: p.name, value: sensitiveKey(p.name) ? '' : String(p.example ?? p.schema?.default ?? ''), enabled: !!p.required, secret: true })));
  if (endpoint.body && endpoint.contentType && /json/i.test(endpoint.contentType)) { request.bodyMode = 'json'; const body = JSON.stringify(example(endpoint.body, endpoint.document || {}), null, 2); request.body = new TextEncoder().encode(body).length <= 128 * 1024 ? body : ''; }
  if (endpoint.contentType === 'application/x-www-form-urlencoded' && endpoint.body) { request.bodyMode = 'form'; request.form = Object.entries(endpoint.body.properties || {}).slice(0, 100).map(([key, raw]) => ({ ...pair(), key, value: sensitiveKey(key) ? '' : String((raw as Json)?.default ?? ''), enabled: Array.isArray(endpoint.body?.required) && endpoint.body.required.includes(key), secret: sensitiveKey(key) })); }
  return request;
}
// Literal declarations only. No module imports, source execution or arbitrary traversal.
export async function discoverSource(project: Project, canceled: () => boolean): Promise<SourceDiscovery> {
  const result: SourceDiscovery = { endpoints: [], openapiPaths: [], fastapi: false, notes: [] };
  const folders = ['']; let files = 0; let bytes = 0; let directories = 0;
  while (folders.length && directories++ < 16 && files < 48 && !canceled()) {
    const folder = folders.shift()!;
    let entries; try { entries = await editorApi.list(project, folder); } catch { result.notes.push('Some source folders were inaccessible.'); continue; }
    for (const entry of entries.slice(0, 500)) {
      if (canceled() || files >= 48 || bytes >= 1024 * 1024) break;
      if (entry.blocked) continue;
      if (entry.directory) { if (/^(src|app|api|routes|routers|server|backend|services)$/.test(entry.name) && entry.path.split('/').length <= 3) folders.push(entry.path); continue; }
      if (entry.name.startsWith('.') || !/\.(py|[cm]?js|ts)$/.test(entry.name) || !entry.size || entry.size > 128 * 1024) continue;
      files++;
      let text: string; try { text = await invoke<string>('api_tester_source', { projectId: project.id, expectedRoot: project.root, path: entry.path }); } catch { continue; }
      bytes += new TextEncoder().encode(text).length;
      // Remove standalone comments; multiline literals/comments are excluded conservatively.
      text = text.replace(/`[^`]*`/g, '').replace(/\/\*[\s\S]*?\*\/|'''[\s\S]*?'''|"""[\s\S]*?"""/g, '').replace(/^\s*(?:#|\/\/).*$/gm, '');
      const fastapi = /(?:from\s+fastapi\s+import|import\s+fastapi\b)/.test(text) && /\bFastAPI\s*\(/.test(text);
      result.fastapi ||= fastapi;
      if (fastapi) {
        const constructor = fastapiArguments(text);
        if (constructor === undefined) continue;
        const configured = constructor.match(/\bopenapi_url\s*=\s*(['"])(\/[^'"]*)\1/);
        if (configured && safePath(configured[2])) result.openapiPaths.push(configured[2]);
        else if (!/\bopenapi_url\s*=/.test(constructor)) result.openapiPaths.push('/openapi.json');
      }
      const add = (method: string, path: string, group: string) => { if (!METHODS.includes(method as Method) || /[()*+?]/.test(path) || !safePath(path) || result.endpoints.length >= 1000) return; result.endpoints.push({ method: method as Method, path: path.replace(/:([A-Za-z_]\w*)|<(?:(?:int|string|float|path|uuid):)?([A-Za-z_]\w*)>/g, (_, a, b) => `{${a || b}}`), summary: entry.path, description: 'Literal source declaration. Runtime registration and availability are unverified.', group, source: 'Source', parameters: [] }); };
      const express = /(?:require\(['"]express['"]\)|from\s+['"]express['"])/.test(text);
      if (express) {
        const roots = [...text.matchAll(/\b(\w+)\s*=\s*express\s*\(/g)].map(m => m[1]);
        const routers = [...text.matchAll(/\b(\w+)\s*=\s*(?:express\.)?Router\s*\(/g)].map(m => m[1]);
        const prefixes = new Map<string, string[]>();
        for (const m of text.matchAll(/^\s*(\w+)\.use\(\s*(['"])(\/[^'"]*)\2\s*,\s*(\w+)\s*\)/gm)) if (roots.includes(m[1]) && routers.includes(m[4])) prefixes.set(m[4], [...(prefixes.get(m[4]) || []), m[3]]);
        for (const m of text.matchAll(/^\s*(\w+)\.(get|post|put|patch|delete|head|options)\(\s*(['"])(\/[^'"]*)\3\s*,/gm)) {
          if (roots.includes(m[1])) add(m[2].toUpperCase(), m[4], 'Express');
          else for (const prefix of prefixes.get(m[1]) || []) add(m[2].toUpperCase(), prefix.replace(/\/$/, '') + m[4], 'Express router');
        }
      }
      if (/from\s+flask\s+import/.test(text)) {
        const apps = [...text.matchAll(/\b(\w+)\s*=\s*Flask\s*\(/g)].map(m => m[1]);
        for (const m of text.matchAll(/^\s*@(\w+)\.(route|get|post|put|patch|delete)\(\s*(['"])(\/[^'"]*)\3([^\n]*)/gm)) if (apps.includes(m[1])) {
          const methods = m[5].match(/methods\s*=\s*\[([^\]]*)\]/);
          if (m[2] !== 'route') add(m[2].toUpperCase(), m[4], 'Flask');
          else if (methods) { for (const verb of methods[1].matchAll(/['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g)) add(verb[1], m[4], 'Flask'); }
          else if (!/methods\s*=/.test(m[5])) add('GET', m[4], 'Flask');
        }
      }
      if (/(?:node:)?http['"]|BaseHTTPRequestHandler/.test(text)) {
        for (const m of text.matchAll(/(?:req|request)\.method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]\s*&&\s*(?:req|request)\.url\s*===?\s*['"](\/[^'"]*)['"]/g)) add(m[1], m[2], 'Node HTTP');
        for (const m of text.matchAll(/^\s*def do_(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(self\):([\s\S]*?)(?=\n\s*def |$)/gm)) for (const route of m[2].matchAll(/\bself\.path\s*==\s*['"](\/[^'"]*)['"]/g)) add(m[1], route[1], 'Python HTTP');
      }
    }
  }
  result.openapiPaths = [...new Set(result.openapiPaths)].slice(0, 3);
  result.notes.push(`Inspected ${files} candidate files in ${Math.min(directories, 16)} folders. Dynamic routes, cross-file router mounts and unrecognized patterns are omitted.`);
  return result;
}
