import React, { useState } from 'react';
import { METHODS, type Method } from './api-tester-api';
import type { Endpoint } from './api-discovery';
export default function ApiExplorer({ endpoints, busy, onSelect, message }: { endpoints: Endpoint[]; busy: boolean; onSelect: (endpoint: Endpoint) => void; message: string }) {
  const [search, setSearch] = useState(''); const [method, setMethod] = useState<Method | ''>('');
  const filtered = endpoints.filter(item => (!method || item.method === method) && `${item.path} ${item.summary}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="api-explorer" aria-label="Discovered API endpoints"><div className="api-section-title"><strong>API Explorer</strong><small>{endpoints.length} routes</small></div>
    <input aria-label="Search endpoints" placeholder="Search routes or operations…" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} />
    <select aria-label="Filter endpoint method" value={method} onChange={e => setMethod(e.target.value as Method | '')}><option value="">All methods</option>{METHODS.map(m => <option key={m}>{m}</option>)}</select>
    <div className="api-route-list">{[...new Set(filtered.map(e => e.group))].map(group => <details key={group} open><summary>{group}<small>{filtered.filter(e => e.group === group).length}</small></summary>{filtered.filter(e => e.group === group).map((e, index) => <button className="api-route" key={`${e.method}:${e.path}:${index}`} disabled={busy} onClick={() => onSelect(e)} title={e.description}><b data-method={e.method}>{e.method}</b><span><code>{e.path}</code>{e.summary && <small>{e.summary}</small>}<small>{e.source} · {e.source === 'OpenAPI' ? 'schema-backed' : 'statically detected · live unverified'}</small></span></button>)}</details>)}</div>
    {!filtered.length && <p className="api-hint">{endpoints.length ? 'No matching endpoints.' : 'Discover APIs to inspect supported local routes, or create a manual request below.'}</p>}
    {message && <p className="api-hint" role="status">{message}</p>}
  </section>;
}
