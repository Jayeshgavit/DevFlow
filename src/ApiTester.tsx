import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Plus, Search, Send, Square, Trash2 } from 'lucide-react';
import { Button, ConfirmDialog, EmptyState } from './components';
import { serviceKey, type Project } from './types';
import { invoke } from '@tauri-apps/api/core';
import ApiExplorer from './ApiExplorer';
import { discoverSource, parseOpenApi, prepareEndpoint, type Endpoint } from './api-discovery';
import { writeLogClipboard } from './log-actions';
import { listen } from '@tauri-apps/api/event';
import { apiTester, METHODS, type ApiOutcome, type ApiRequest, type ApiStore, type Pair, type SavedRequest } from './api-tester-api';
import { blankRequest, newId, pair, persistedRequest, sensitiveKey, serviceEndpoint, validateRequest } from './api-tester-state';
import ApiTextEditor, { type ApiTextHandle } from './ApiTextEditor';
import './api-tester.css';

type Confirmation = { title: string; description: string; confirmText: string; destructive?: boolean; action: () => void };
const REQUEST_TEXT_LIMIT = 128 * 1024;
// These IPC commands return controlled messages without URLs, bodies, or headers.
const failure = (cause: unknown, fallback: string) => typeof cause === 'string' ? cause : fallback;
function PairEditor({ rows, setRows, label }: { rows: Pair[]; setRows: (rows: Pair[]) => void; label: string }) {
  const update = (id: string, patch: Partial<Pair>) => setRows(rows.map(row => row.id === id ? { ...row, ...patch } : row));
  return <div className="api-pairs"><p className="api-hint">{label === 'Header' ? 'Duplicate enabled header names are rejected. Header values default to session only.' : 'Enabled rows are appended in order. Duplicate parameter names are preserved. Mark sensitive values as session only.'}</p>
    {rows.map((row, index) => <div className="api-pair" key={row.id}>
      <input type="checkbox" checked={row.enabled} aria-label={`Enable ${label} ${index + 1}`} onChange={event => update(row.id, { enabled: event.target.checked })} />
      <input aria-label={`${label} ${index + 1} name`} placeholder="Key" value={row.key} maxLength={512} onChange={event => update(row.id, { key: event.target.value })} autoComplete="off" spellCheck={false} />
      <input aria-label={`${label} ${index + 1} value`} placeholder={row.secret || sensitiveKey(row.key) ? 'Session-only value' : 'Value'} value={row.value} type={row.secret || sensitiveKey(row.key) ? 'password' : 'text'} maxLength={16384} onChange={event => update(row.id, { value: event.target.value })} autoComplete="off" spellCheck={false} />
      <label className="api-secret" title="Session-only values are excluded from saved requests and history"><input type="checkbox" checked={row.secret || sensitiveKey(row.key)} disabled={sensitiveKey(row.key)} onChange={event => update(row.id, { secret: event.target.checked })} />Session only</label>
      <Button tone="quiet" aria-label={`Remove ${label} ${index + 1}`} onClick={() => setRows(rows.filter(item => item.id !== row.id))}><Trash2 size={14} /></Button>
    </div>)}
    <Button disabled={rows.length >= 100} icon={<Plus size={14} />} onClick={() => setRows([...rows, { ...pair(), secret: label === 'Header' }])}>Add {label.toLowerCase()}</Button>
  </div>;
}
export default function ApiTester({ project, projects, selectProject, initialUrl, running }: { running: string[]; project?: Project; projects: Project[]; selectProject: (id: string) => void; initialUrl?: string }) {
  return <section className="api-tester" aria-label="API Tester"><header className="api-heading"><div><h1>API Tester</h1><p>Send HTTP requests to local development services.</p></div><label>Project<select aria-label="API Tester project" value={project?.id || ''} onChange={event => selectProject(event.target.value)}><option value="" disabled>Select a project</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></header>
    {project ? <ProjectTester key={project.id} project={project} initialUrl={initialUrl} running={running} /> : <EmptyState icon={<Send size={24} />} title="Select a project" description="Choose a saved project to keep its API requests and history separate." />}
  </section>;
}
function ProjectTester({ project, initialUrl, running }: { project: Project; initialUrl?: string; running: string[] }) {
  const [discovered, setDiscovered] = useState<Endpoint[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const discoveryLock = useRef(false);
  const [serviceId, setServiceId] = useState('');
  const [openapiPath, setOpenapiPath] = useState('');
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [selectedEndpoint, setSelectedEndpoint] = useState<Endpoint>();
  const [responseHeight, setResponseHeight] = useState(() => { try { return Math.max(180, Math.min(700, Number(localStorage.getItem('devflow-api-response-height')) || 340)); } catch { return 340; } });
  const [store, setStore] = useState<ApiStore>(); const storeRef = useRef<ApiStore>();
  const [draft, setDraft] = useState<ApiRequest>(() => ({ ...blankRequest(), url: initialUrl || '' })); const draftRef = useRef(draft); draftRef.current = draft;
  const [savedId, setSavedId] = useState<string | null>(null);
  const [documentKey, setDocumentKey] = useState(0);
  const [name, setName] = useState('Untitled request'); const [collection, setCollection] = useState('');
  const [folderName, setFolderName] = useState(''); const [filter, setFilter] = useState('');
  const [tab, setTab] = useState<'Params' | 'Headers' | 'Body' | 'Auth'>('Params');
  const [outcome, setOutcome] = useState<ApiOutcome>(); const [busy, setBusy] = useState(false); const [canceling, setCanceling] = useState(false);
  const [sentMethod, setSentMethod] = useState<ApiRequest['method']>('GET');
  const [pretty, setPretty] = useState({ text: '', json: false, source: '' }); const [responseMode, setResponseMode] = useState<'pretty' | 'raw' | 'headers'>('pretty');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [dirty, setDirty] = useState(!!initialUrl);
  const [saving, setSaving] = useState(0); const [confirm, setConfirm] = useState<Confirmation>();
  const alive = useRef(true); const active = useRef<{ id: string; canceled: boolean }>();
  const queue = useRef<Promise<unknown>>(Promise.resolve()); const revision = useRef(0);
  const saveLock = useRef(false); const pendingWrites = useRef(0);
  const nameInput = useRef<HTMLInputElement>(null); const responseEditor = useRef<ApiTextHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const patch = (change: Partial<ApiRequest>) => { setDraft(current => ({ ...current, ...change })); setDirty(true); revision.current++; setError(''); setNotice(''); };
  useEffect(() => {
    let disposed = false;
    alive.current = true;
    apiTester.load(project.id).then(data => {
      if (disposed || !alive.current) return; storeRef.current = data; setStore(data);
      const selected = data.requests.find(item => item.id === data.lastSelected);
      if (selected && !initialUrl) { setSavedId(selected.id); setName(selected.name); setCollection(selected.collection); setDraft(selected.request); }
      root.current?.focus();
    }).catch(cause => { if (!disposed && alive.current) setError(failure(cause, 'Could not load API Tester storage. Existing files were preserved.')); });
    let stop: (() => void) | undefined;
    void listen('api-tester-closing', () => {
      if (disposed) return;
      const request = active.current;
      if (request) { request.canceled = true; setCanceling(true); void apiTester.cancel(request.id).catch(() => {}); }
    }, { target: 'main' }).then(unlisten => { if (!disposed && alive.current) stop = unlisten; else unlisten(); }).catch(() => {});
    return () => { disposed = true; alive.current = false; stop?.(); const request = active.current; if (request) { request.canceled = true; void apiTester.cancel(request.id).catch(() => {}); } };
  }, [project.id]);
  useEffect(() => {
    setPretty({ text: '', json: false, source: '' });
    if (!outcome?.body) return;
    let worker: Worker;
    try { worker = new Worker(new URL('./api-tester-format.worker.ts', import.meta.url), { type: 'module' }); }
    catch { setPretty({ text: outcome.body, json: false, source: outcome.body }); return; }
    let disposed = false;
    worker.onmessage = (event: MessageEvent<{ text: string; json: boolean }>) => { if (!disposed) setPretty({ ...event.data, source: outcome.body }); worker.terminate(); };
    worker.onerror = () => { if (!disposed) setPretty({ text: outcome.body, json: false, source: outcome.body }); worker.terminate(); };
    worker.postMessage(outcome.body); return () => { disposed = true; worker.terminate(); };
  }, [outcome]);
  // All writes are serialized against the latest acknowledged revision. A failed
  // write never publishes optimistic collection changes or permits overwrite.
  function mutate(change: (current: ApiStore) => ApiStore): Promise<boolean> {
    if (!storeRef.current) return Promise.resolve(false);
    if (pendingWrites.current >= 8) { setError('Wait for pending saves to finish.'); return Promise.resolve(false); }
    pendingWrites.current++;
    setSaving(value => value + 1);
    const task = queue.current.then(async () => {
      const current = storeRef.current; if (!current) return false;
      try {
        const saved = await apiTester.save(project.id, change(current)); storeRef.current = saved;
        if (alive.current) { setStore(saved); setError(''); } return true;
      } catch (cause) {
        if (alive.current) setError(failure(cause, 'API Tester data could not be saved. Previous storage was preserved.'));
        return false;
      } finally { pendingWrites.current--; if (alive.current) setSaving(value => value - 1); }
    }); queue.current = task; return task;
  }
  const guardDraft = (action: () => void) => {
    if (busy) return;
    if (dirty) setConfirm({ title: 'Discard unsaved request changes?', description: 'Only explicitly saved nonsecret configuration is retained. Session-only credentials and unsaved changes will be discarded.', confirmText: 'Discard changes', destructive: true, action });
    else action();
  };
  const openSaved = (item: SavedRequest) => guardDraft(() => {
    setSelectedEndpoint(undefined); setPathValues({}); setDocumentKey(value => value + 1); setDraft(JSON.parse(JSON.stringify(item.request))); setSavedId(item.id); setName(item.name); setCollection(item.collection); setDirty(false); setOutcome(undefined); setNotice('Opened saved request. Re-enter any session-only values.'); setError(''); revision.current++;
    void mutate(current => ({ ...current, lastSelected: item.id }));
  });
  const reset = () => guardDraft(() => { setSelectedEndpoint(undefined); setPathValues({}); setDocumentKey(value => value + 1); setDraft(blankRequest()); setName('Untitled request'); setCollection(''); setSavedId(null); setOutcome(undefined); setDirty(false); setError(''); setNotice(''); revision.current++; void mutate(current => ({ ...current, lastSelected: null })); });
  async function saveRequest() {
    if (!storeRef.current || saving || busy || saveLock.current) return;
    if (!name.trim() || name.trim().length > 200) { setError('Enter a request name (up to 200 characters).'); return; }
    const id = savedId || newId(); const version = revision.current;
    const item = { id, name: name.trim(), collection, request: persistedRequest(draftRef.current) };
    if (!savedId && storeRef.current.requests.length >= 100) { setError('100 saved requests reached. Delete an unused request first.'); return; }
    saveLock.current = true;
    try {
      if (await mutate(current => ({ ...current, requests: [...current.requests.filter(r => r.id !== id), item], lastSelected: id }))) {
        if (alive.current && revision.current === version) { setSavedId(id); setDirty(false); const bodyOmitted = !draft.bodySecret && draft.body && storeRef.current?.requests.find(r => r.id === id)?.request.bodySecret; setNotice(bodyOmitted ? 'Saved configuration. The body contained credential-like fields and was excluded.' : 'Saved nonsecret configuration. Auth, URL query values, and session-only inputs are excluded.'); }
      }
    } finally { saveLock.current = false; }
  }
  async function cancel() {
    const request = active.current; if (!request) return;
    request.canceled = true; setCanceling(true);
    try { await apiTester.cancel(request.id); } catch { if (alive.current) setError('Cancellation could not be delivered. The backend timeout still applies.'); }
  }
  async function send() {
    if (busy || discoveryLock.current || active.current || !storeRef.current || confirm || pendingWrites.current) return;
    const request = JSON.parse(JSON.stringify(draftRef.current)) as ApiRequest;
    const validation = validateRequest(request);
    if (validation) {
      setError(validation);
      setOutcome({ kind: /URL|localhost|127\.0/.test(validation) ? 'invalidUrl' : 'validation', message: '', status: null, statusLabel: '', durationMs: 0, size: 0, headers: [], body: '', truncated: false });
      return;
    }
    if (/\{[^}]+\}|%7b[^/]*%7d/i.test(request.url)) { setError('Fill all path parameters before sending.'); return; }
    const session = { id: newId(), canceled: false }; active.current = session;
    setBusy(true); setCanceling(false); setOutcome(undefined); setSentMethod(request.method); setNotice(''); setError('');
    try {
      await apiTester.prepare(project.id, session.id);
      // Covers cancellation/navigation before the prepare IPC has acknowledged.
      if (session.canceled || !alive.current) await apiTester.cancel(session.id);
      if (!alive.current) return;
      const result = await apiTester.send(project.id, session.id, request);
      if (!alive.current || active.current !== session) return;
      setOutcome(result);
      const safe = persistedRequest(request, true);
      void mutate(current => ({ ...current, history: [{ id: session.id, timestamp: Date.now(), method: safe.method, url: safe.url, durationMs: result.durationMs, result: result.status ? String(result.status) : result.kind, request: safe }, ...current.history].slice(0, 30) }));
    } catch {
      if (alive.current && active.current === session) setError('Could not execute the request. Check the saved project, request size, and API Tester backend availability.');
    } finally {
      // Also removes a reservation if send failed before entering the backend.
      await apiTester.cancel(session.id).catch(() => {});
      if (active.current === session) { active.current = undefined; if (alive.current) { setBusy(false); setCanceling(false); } }
    }
  }
  const endpoints = useMemo(() => project.services.flatMap(service => { const url = serviceEndpoint(service); return url ? [{ id: service.id, name: service.name, framework: service.framework, url: new URL(url).origin, running: running.includes(serviceKey(project.id, service.id)) }] : []; }), [project.services, running, project.id]);
  const selectedService = endpoints.find(item => item.id === serviceId) || endpoints.find(item => item.running && /fastapi/i.test(item.framework || '')) || endpoints.find(item => item.running) || endpoints[0];
  const serviceSignature = `${selectedService?.id || ''}:${selectedService?.url || ''}:${selectedService?.running || false}`;
  useEffect(() => {
    setDiscovered([]); setDiscoveryMessage('');
    if (discoveryLock.current && active.current) { active.current.canceled = true; void apiTester.cancel(active.current.id).catch(() => {}); }
  }, [serviceSignature]);
  async function discover() {
    if (discoveryLock.current || active.current || busy) return;
    discoveryLock.current = true; setDiscovering(true); setBusy(true); setError(''); setDiscoveryMessage('Inspecting bounded source files-');
    const session = { id: newId(), canceled: false }; active.current = session;
    try {
      const source = await discoverSource(project, () => session.canceled || !alive.current);
      if (!alive.current || session.canceled) return;
      let routes = source.endpoints;
      const notes = [...source.notes];
      const [savedProjects, currentRunning, stopping] = await Promise.all([invoke<Project[]>('load_projects'), invoke<string[]>('running_services'), invoke<string[]>('stopping_services')]);
      const saved = savedProjects.find(p => p.id === project.id && p.root === project.root);
      const service = saved?.services.find(s => s.id === selectedService?.id);
      const trustedUrl = service && serviceEndpoint(service);
      const runningNow = service && currentRunning.includes(serviceKey(project.id, service.id)) && !stopping.includes(serviceKey(project.id, service.id));
      const base = trustedUrl ? new URL(trustedUrl).origin : '';
      if (base && base === selectedService?.url && runningNow && (source.fastapi || /fastapi/i.test(service?.framework || '') || openapiPath)) {
        const paths = openapiPath ? [openapiPath] : source.openapiPaths;
        if (!paths.length) notes.push('No literal enabled OpenAPI path was established. Enter its verified path to fetch a schema.');
        for (const path of paths) {
          if (session.canceled || !alive.current) return;
          if (!path.startsWith('/') || path.startsWith('//') || /[\\\s?#]/.test(path) || path.length > 2048) { notes.push('OpenAPI path must be a local absolute path without query or fragment.'); break; }
          setDiscoveryMessage('Reading local OpenAPI schema-');
          await apiTester.prepare(project.id, session.id);
          if (session.canceled || !alive.current) { await apiTester.cancel(session.id); return; }
          const response = await apiTester.send(project.id, session.id, { ...blankRequest(), url: base + path, timeoutSeconds: 8 });
          if (session.canceled || !alive.current) return;
          if (response.status !== 200 || response.truncated) { notes.push('OpenAPI unavailable or exceeds the 1 MiB limit; source results retained.'); continue; }
          try { const schemaRoutes = parseOpenApi(response.body); routes = [...schemaRoutes, ...routes.filter(r => !schemaRoutes.some(s => s.method === r.method && s.path === r.path))]; notes.push('OpenAPI servers ignored; requests use the selected local service.'); break; }
          catch { notes.push('OpenAPI JSON was invalid or unsupported; source results retained.'); }
        }
      } else notes.push('OpenAPI requires a saved, currently managed running service with a known loopback endpoint. Manual requests remain available.');
      if (alive.current && !session.canceled) { setDiscovered(routes); setDiscoveryMessage(notes.join(' ')); }
    } catch { if (alive.current) setDiscoveryMessage('Discovery could not complete. Existing results retained; check saved project and service configuration.'); }
    finally { await apiTester.cancel(session.id).catch(() => {}); if (active.current === session) active.current = undefined; discoveryLock.current = false; if (alive.current) { setBusy(false); setDiscovering(false); setCanceling(false); if (session.canceled) setDiscoveryMessage('Discovery canceled. Existing results retained.'); } }
  }
  function selectEndpoint(endpoint: Endpoint) {
    guardDraft(() => {
      const request = prepareEndpoint(endpoint, selectedService?.url || (() => { try { return new URL(draft.url).origin; } catch { return ''; } })());
      setDraft(request); setSelectedEndpoint(endpoint); setPathValues({}); setSavedId(null); setName(endpoint.summary || `${endpoint.method} ${endpoint.path}`); setDocumentKey(v => v + 1); setDirty(true); setOutcome(undefined); setError(''); setNotice(`${endpoint.source} route prepared. Review parameters and body before sending. ${endpoint.contentType && !/json|x-www-form-urlencoded/.test(endpoint.contentType) ? 'This declared body format requires manual configuration.' : 'Replace required-value placeholders before sending.'}`); revision.current++;
    });
  }
  const filtered = store?.requests.filter(item => `${item.name} ${item.request.url}`.toLowerCase().includes(filter.toLowerCase())) || [];
  const responseText = !outcome ? '' : responseMode === 'headers' ? outcome.headers.map(([key, value]) => `${key}: ${value}`).join('\n') : responseMode === 'raw' ? outcome.body : (pretty.source === outcome.body ? pretty.text : '') || outcome.body;
  const copy = async (selection = false) => {
    const text = selection ? responseEditor.current?.selection() || '' : responseText;
    if (!text) { setNotice('Select response text to copy.'); return; }
    try { await writeLogClipboard(text); if (alive.current) setNotice(selection ? 'Selection copied.' : 'Response copied.'); }
    catch { if (alive.current) setError('Could not copy response to the clipboard.'); }
  };
  return <div ref={root} className="api-project" tabIndex={-1} onKeyDown={event => {
    if (confirm || event.altKey || event.metaKey) return;
    if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void send(); }
    else if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void saveRequest(); }
    else if (event.key === 'Escape' && busy) { event.preventDefault(); event.stopPropagation(); void cancel(); }
  }}>
    <aside className="api-library" aria-label="API explorer and requests">
      <ApiExplorer endpoints={discovered} busy={busy || !!saving} onSelect={selectEndpoint} message={discoveryMessage} />
      <details open><summary>Saved requests - Manual</summary>
      <div className="api-section-title"><strong>Saved requests</strong><Button tone="quiet" disabled={!store || busy} aria-label="New request" onClick={reset}><Plus size={16} /></Button></div>
      <input aria-label="Search saved requests" placeholder="Filter name or URL…" value={filter} maxLength={200} onChange={event => setFilter(event.target.value)} />
      {!store && <p role="status">{error ? 'Storage unavailable. No data was overwritten.' : 'Loading saved requests…'}</p>}
      <div className="api-saved-list">{['', ...(store?.collections || [])].map(folder => <section key={folder}>
        <div className="api-folder-heading"><strong>{folder || 'Unfiled'}</strong>{folder && <Button tone="quiet" disabled={!!saving || busy} aria-label={`Delete collection ${folder}`} onClick={() => setConfirm({ title: 'Delete collection?', description: 'Requests in this collection will move to Unfiled.', confirmText: 'Delete collection', destructive: true, action: () => { void mutate(current => ({ ...current, collections: current.collections.filter(f => f !== folder), requests: current.requests.map(r => r.collection === folder ? { ...r, collection: '' } : r) })); if (collection === folder) setCollection(''); } })}><Trash2 size={12} /></Button>}</div>
        {filtered.filter(item => item.collection === folder).map(item => <button key={item.id} disabled={busy || !!saving} className={`api-saved ${savedId === item.id ? 'is-active' : ''}`} aria-current={savedId === item.id ? 'true' : undefined} onClick={() => openSaved(item)}><small>{item.request.method}</small><span>{item.name}<small>{item.request.url || 'No URL'}</small></span></button>)}
      </section>)}{store && !filtered.length && <p className="api-hint">No matching saved requests.</p>}</div>
      <div className="api-new-folder"><input aria-label="New collection name" placeholder="Collection name" maxLength={100} value={folderName} onChange={event => setFolderName(event.target.value)} /><Button disabled={!store || busy || !!saving || !folderName.trim() || (store.collections.length >= 30)} aria-label="Add collection" onClick={() => { const folder = folderName.trim(); if (storeRef.current?.collections.includes(folder)) { setError('That collection already exists.'); return; } void mutate(current => ({ ...current, collections: [...current.collections, folder] })).then(ok => { if (ok && alive.current) { setFolderName(''); setCollection(folder); setDirty(true); revision.current++; } }); }}><Plus size={14} /></Button></div>
      </details><details><summary>Recent requests</summary><div className="api-section-title"><strong>Recent requests</strong><Button tone="quiet" disabled={!store?.history.length || !!saving} onClick={() => setConfirm({ title: 'Clear request history?', description: 'Remove this project’s recent request history. Saved requests are retained.', confirmText: 'Clear history', destructive: true, action: () => { void mutate(current => ({ ...current, history: [] })); } })}>Clear</Button></div>
      <div className="api-history">{store?.history.map(item => <button key={item.id} disabled={busy || !!saving} onClick={() => guardDraft(() => { setSelectedEndpoint(undefined); setPathValues({}); setDocumentKey(value => value + 1); setDraft(item.request); setSavedId(null); setName('From history'); setCollection(''); setDirty(true); setOutcome(undefined); revision.current++; setNotice('History reopened without transient values. Fill session-only inputs before sending.'); })}><span>{item.method} · {item.result} · {item.durationMs} ms</span><small>{item.url}</small><time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleString()}</time></button>)}{store && !store.history.length && <p className="api-hint">No requests sent yet.</p>}</div>
      </details>
    </aside>
    <div className="api-workspace">
      <div className="api-discovery-bar"><div><strong>Local API workspace</strong><small>{selectedService ? `${selectedService.name} - ${selectedService.running ? 'Running process - readiness unverified' : 'Configured - not running'}` : 'Unknown endpoint - enter a loopback URL below'}</small></div><Button disabled={busy || !store || !!saving} onClick={() => void discover()}>{discovering ? 'Discovering-' : 'Discover APIs'}</Button></div>
      <div className="api-savebar"><input disabled={!store || busy || !!saving} ref={nameInput} aria-label="Request name" maxLength={200} value={name} onChange={event => { setName(event.target.value); setDirty(true); revision.current++; }} /><select disabled={!store || busy || !!saving} aria-label="Request collection" value={collection} onChange={event => { setCollection(event.target.value); setDirty(true); revision.current++; }}><option value="">Unfiled</option>{store?.collections.map(folder => <option key={folder}>{folder}</option>)}</select>
        <Button disabled={!store || !!saving || busy} title="Save or rename request (Ctrl+S)" onClick={() => void saveRequest()}>{saving ? 'Saving…' : dirty ? 'Save changes' : 'Save'}</Button>
        <Button disabled={!savedId || !!saving || busy} onClick={() => { nameInput.current?.focus(); nameInput.current?.select(); }}>Rename</Button>
        <Button disabled={!savedId || !!saving || busy || (store?.requests.length || 0) >= 100} onClick={() => { const id = newId(); const item = { id, name: `${name.slice(0, 190)} copy`, collection, request: persistedRequest(draft) }; void mutate(current => ({ ...current, requests: [...current.requests, item], lastSelected: id })).then(ok => { if (ok && alive.current) { setSavedId(id); setName(item.name); setDirty(false); setNotice('Duplicated nonsecret request configuration.'); } }); }}><Copy size={14} />Duplicate</Button>
        <Button tone="quiet" disabled={!savedId || !!saving || busy} aria-label="Delete saved request" onClick={() => { const id = savedId; setConfirm({ title: 'Delete saved request?', description: 'This removes the saved configuration from this project. Recent history is retained.', confirmText: 'Delete request', destructive: true, action: () => { void mutate(current => ({ ...current, requests: current.requests.filter(item => item.id !== id), lastSelected: current.lastSelected === id ? null : current.lastSelected })).then(ok => { if (ok && alive.current) { setSavedId(null); setDirty(true); } }); } }); }}><Trash2 size={14} /></Button>
      </div>
      <div className="api-toolbar"><select disabled={!store || busy || !!saving} aria-label="HTTP method" value={draft.method} onChange={event => patch({ method: event.target.value as ApiRequest['method'] })}>{METHODS.map(method => <option key={method}>{method}</option>)}</select><input disabled={!store || busy || !!saving} aria-label="Request URL" value={draft.url} maxLength={8192} placeholder="http://localhost:port/path" autoComplete="off" spellCheck={false} onChange={event => patch({ url: event.target.value })} />
        <Button tone="primary" disabled={!store || busy || !!saving} title="Send request (Ctrl+Enter)" icon={<Send size={15} />} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</Button><Button disabled={!busy || canceling} title="Cancel request (Escape)" icon={<Square size={13} />} onClick={() => void cancel()}>{canceling ? 'Canceling…' : 'Cancel'}</Button>
      </div>
      <div className="api-endpoints"><label>Service endpoint<select aria-label="Service endpoint" value={selectedService?.id || ''} disabled={busy || !!saving || !endpoints.length} onChange={event => { setServiceId(event.target.value); setDiscovered([]); setDiscoveryMessage('Service changed. Refresh discovery.'); const target = endpoints.find(item => item.id === event.target.value); if (target) patch({ url: target.url }); }}><option value="" disabled>Unknown - manual URL</option>{endpoints.map(item => <option key={item.id} value={item.id}>{item.name} - {item.running ? 'Running process' : 'Configured - not running'} - {item.url}</option>)}</select></label><label>OpenAPI path<input aria-label="OpenAPI path override" disabled={busy} placeholder="Auto from source" value={openapiPath} maxLength={2048} onChange={e => setOpenapiPath(e.target.value)} /></label><label>Timeout (s)<input disabled={!store || busy || !!saving} type="number" min={1} max={120} value={draft.timeoutSeconds} onChange={event => patch({ timeoutSeconds: Number(event.target.value) })} /></label><Button tone="quiet" disabled={!store || busy || !!saving} onClick={reset}>Clear request</Button></div>
      <p className="api-hint">Loopback only · no redirects · 256 KiB request / 1 MiB response · Auth stays in memory. URL query values stay in memory; use Params for nonsecret saved values. Unsaved drafts and credentials are discarded when leaving this view or changing projects.</p>
      {error && <p className="api-error" role="alert">{error}</p>}<p className="api-notice" role="status">{notice}</p>
      <section className="api-request" aria-label="Request configuration"><div className="api-tabs" role="tablist" aria-label="Request configuration">{(['Params', 'Headers', 'Body', 'Auth'] as const).map(item => <button key={item} id={`api-tab-${item}`} role="tab" tabIndex={tab === item ? 0 : -1} onKeyDown={event => {
          const tabs = ['Params', 'Headers', 'Body', 'Auth'] as const;
          const index = tabs.indexOf(item);
          const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : undefined;
          if (next) { event.preventDefault(); event.stopPropagation(); setTab(next); document.getElementById(`api-tab-${next}`)?.focus(); }
        }} aria-selected={tab === item} aria-controls="api-request-panel" onClick={() => setTab(item)}>{item}</button>)}</div>
        <fieldset disabled={busy || !!saving || !store} className="api-request-fields" id="api-request-panel" role="tabpanel" aria-labelledby={`api-tab-${tab}`}>
          {tab === 'Params' && <>{selectedEndpoint && <div className="api-path-params">{[...selectedEndpoint.path.matchAll(/\{([^}]+)\}/g)].map(match => <label key={match[1]}>Path - {match[1]}<input aria-label={`Path parameter ${match[1]}`} value={typeof pathValues[match[1]] === 'string' ? pathValues[match[1]] : ''} placeholder="Required" onChange={event => { const values = { ...pathValues, [match[1]]: event.target.value }; setPathValues(values); const route = selectedEndpoint.path.replace(/\{([^}]+)\}/g, (placeholder, key) => typeof values[key] === 'string' && values[key].trim() ? encodeURIComponent(values[key]) : placeholder); let base = ''; try { base = new URL(draft.url).origin; } catch {} patch({ url: base + route }); }} /></label>)}</div>}<PairEditor label="Parameter" rows={draft.params} setRows={params => patch({ params })} />{selectedEndpoint && <details><summary>Declared parameters & schema</summary><ApiTextEditor label="Endpoint schema" value={JSON.stringify({ description: selectedEndpoint.description, parameters: selectedEndpoint.parameters, contentType: selectedEndpoint.contentType, schema: selectedEndpoint.body }, null, 2)} jsonMode /></details>}</>}
          {tab === 'Headers' && <><PairEditor label="Header" rows={draft.headers} setRows={headers => patch({ headers })} /><p className="api-hint">Header values default to session only. Custom-header authorization always stays in memory. Sensitive header names are always session only. Duplicate enabled headers are rejected.</p></>}
          {tab === 'Body' && <><div className="api-body-options"><label>Body type<select value={draft.bodyMode} onChange={event => patch({ bodyMode: event.target.value as ApiRequest['bodyMode'] })}><option value="none">None</option><option value="json">JSON</option><option value="text">Plain text</option><option value="form">Form URL encoded</option></select></label>{['json', 'text'].includes(draft.bodyMode) && <label><input type="checkbox" checked={draft.bodySecret} onChange={event => patch({ bodySecret: event.target.checked })} />Session-only body (recommended)</label>}</div>
            {draft.bodyMode === 'none' && <p className="api-hint">No request body will be sent.</p>}
            {draft.bodyMode === 'form' && <PairEditor label="Form field" rows={draft.form} setRows={form => patch({ form })} />}
            {['json', 'text'].includes(draft.bodyMode) && <><p className="api-hint">Uncheck session-only only for nonsecret body content. Detected credential fields are excluded regardless. Text editor limit: 128 KiB.</p><ApiTextEditor key={`body-${documentKey}-${busy || !!saving}`} label="Request body" onLimit={() => setError('Body editor limit is 128 KiB. Reduce the pasted content.')} value={draft.body} jsonMode={draft.bodyMode === 'json'} onChange={busy || saving ? undefined : body => { if (new TextEncoder().encode(body).length > REQUEST_TEXT_LIMIT) { setError('Body editor limit is 128 KiB.'); return; } patch({ body }); }} /></>}
          </>}
          {tab === 'Auth' && <div className="api-auth"><label>Authorization<select value={draft.auth} onChange={event => patch({ auth: event.target.value as ApiRequest['auth'] })}><option value="none">None</option><option value="bearer">Bearer token</option><option value="basic">Basic authentication</option><option value="headers">Custom headers</option></select></label>{draft.auth === 'bearer' && <label>Bearer token (session only)<input type="password" value={draft.token} maxLength={16384} autoComplete="off" onChange={event => patch({ token: event.target.value })} /></label>}{draft.auth === 'basic' && <><label>Username (session only)<input value={draft.username} maxLength={4096} autoComplete="off" onChange={event => patch({ username: event.target.value })} /></label><label>Password (session only)<input type="password" value={draft.password} maxLength={16384} autoComplete="new-password" onChange={event => patch({ password: event.target.value })} /></label></>}{draft.auth === 'headers' && <><p>Configure custom authorization in Headers. All header values in this authorization mode are session only.</p><Button onClick={() => setTab('Headers')}>Edit headers</Button></>}<p className="api-hint">Auth inputs and session-only values are excluded from saved files and history. Requests and responses are never forwarded to Logs, notifications, or AI context. Session inputs are discarded when leaving this view or switching projects.</p></div>}
        </fieldset>
      </section>
      <div className="api-response-resize" role="separator" aria-label="Resize response panel" aria-orientation="horizontal" tabIndex={0} onKeyDown={e => { if (['ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const height = Math.max(180, Math.min(700, responseHeight + (e.key === 'ArrowUp' ? 24 : -24))); setResponseHeight(height); try { localStorage.setItem('devflow-api-response-height', String(height)); } catch {} } }} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { const height = Math.max(180, Math.min(window.innerHeight * .7, responseHeight - e.movementY)); setResponseHeight(height); } }} onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); try { localStorage.setItem('devflow-api-response-height', String(responseHeight)); } catch {} }} />
      <section className="api-response" style={{ '--api-response-height': `${responseHeight}px` } as React.CSSProperties} aria-label="Response"><div className="api-response-heading"><strong>Response</strong><span role="status">{busy ? canceling ? 'Canceling…' : discovering ? 'Discovering APIs…' : 'Sending…' : outcome ? outcome.status ? `${outcome.status} ${outcome.statusLabel}${outcome.status >= 400 ? ' · HTTP error response' : ''}` : outcome.kind === 'canceled' ? 'Canceled' : outcome.kind === 'timeout' ? 'Timeout' : outcome.kind === 'refused' ? 'Connection refused' : outcome.kind === 'invalidUrl' ? 'Invalid URL' : outcome.kind === 'validation' ? 'Validation error' : 'Request failed' : 'Waiting to send'}</span>{outcome && <small>{outcome.durationMs} ms · {outcome.size.toLocaleString()} bytes{outcome.truncated ? ' · truncated' : ''}</small>}</div>
        {outcome?.message && <p className={outcome.status ? 'api-hint' : 'api-error'}>{outcome.message}</p>}
        <div className="api-response-actions"><div className="api-tabs" role="group" aria-label="Response display">{(['pretty', 'raw', 'headers'] as const).map(mode => <button key={mode} aria-pressed={responseMode === mode} onClick={() => setResponseMode(mode)}>{mode === 'pretty' ? 'Pretty' : mode === 'raw' ? 'Raw' : 'Headers'}</button>)}</div><Button disabled={!responseText} icon={<Search size={14} />} onClick={() => responseEditor.current?.find()}>Find</Button><Button disabled={!responseText} onClick={() => void copy()}>Copy response</Button><Button disabled={!responseText} onClick={() => void copy(true)}>Copy selection</Button></div>
        {responseText ? <ApiTextEditor ref={responseEditor} label="Response content" value={responseText} jsonMode={responseMode === 'pretty' && pretty.source === outcome?.body && pretty.json} /> : <p className="api-response-empty">{outcome?.status ? sentMethod === 'HEAD' ? 'HEAD responses have no body. See Headers.' : responseMode === 'headers' ? 'No response headers.' : 'Empty response body. See Headers.' : 'Send a request to inspect its status, headers, and body.'}</p>}
      </section>
    </div>
    {confirm && <ConfirmDialog title={confirm.title} description={confirm.description} confirmText={confirm.confirmText} destructive={confirm.destructive} onCancel={() => setConfirm(undefined)} onConfirm={() => { const action = confirm.action; setConfirm(undefined); action(); }} />}
  </div>;
}
