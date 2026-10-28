import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Copy, Network, RefreshCw, Search } from 'lucide-react';
import { Button, Card, ConfirmDialog } from './components';
import type { Project, Service } from './types';
import { serviceKey } from './types';
import './port-manager.css';

type Listener = { address: string; family: string; port: number; pid: number; executable: string | null; name: string | null; creationTime: string | null; serviceKey: string | null; runToken: string | null; ownershipVerified: boolean; inspection: string };
type Inventory = { listeners: Listener[]; errors: string[]; inspectedAt: number };
type Diagnosis = { kind: 'managed' | 'conflict' | 'potential' | 'listening'; message: string };

function overlap(host: string | undefined, row: Listener): 'exact' | 'possible' | 'none' {
  if (!host || host === 'localhost') return 'possible';
  const normalized = host.replace(/^\[|\]$/g, '');
  if (normalized === row.address) return 'exact';
  if (row.address === '::' || normalized === '::') return 'possible'; // IPV6_V6ONLY is not known.
  if (row.family === 'IPv4' && (row.address === '0.0.0.0' || normalized === '0.0.0.0')) return 'exact';
  if (/^[\d.]+$/.test(normalized) || normalized.includes(':')) return 'none';
  return 'possible';
}
function diagnose(row: Listener, project?: Project): Diagnosis {
  if (project?.services.some(service => row.serviceKey === serviceKey(project.id, service.id)))
    return { kind: 'managed', message: 'Listener associated with this project through verified Windows Job membership.' };
  const expected = project?.services.filter(service => service.port === row.port && overlap(service.host, row) !== 'none') ?? [];
  if (expected.length) {
    // A managed service with no matching listener may be starting, exiting or binding elsewhere.
    // Windows permits some forms of socket sharing; occupancy does not prove startup failure.
    const exact = expected.some(service => overlap(service.host, row) === 'exact');
    if (exact && row.creationTime && (row.serviceKey || row.ownershipVerified))
      return { kind: 'conflict', message: `Port ${row.port} is occupied on an overlapping bind by a verified process outside this project's managed services. This does not prove startup failure or rule out deliberate socket sharing.` };
    return { kind: 'potential', message: `Possible conflict on port ${row.port} — ${!row.creationTime ? 'process identity unavailable' : !exact ? 'configured interface or IPv6 dual-stack overlap is uncertain' : 'ownership outside managed services is unverified'}. Review the owner or change the configured port.` };
  }
  return { kind: 'listening', message: 'TCP listener observed. Separate address bindings and duplicate port numbers are not automatically conflicts.' };
}
const labels = { managed: 'Selected project', conflict: 'Confirmed occupancy conflict', potential: 'Possible conflict', listening: 'Listening' };

export default function PortManager({ project, projects, selectProject }: { project?: Project; projects: Project[]; selectProject: (id: string) => void }) {
  const [inventory, setInventory] = useState<Inventory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [family, setFamily] = useState('all');
  const [expanded, setExpanded] = useState<string>();
  const [confirmation, setConfirmation] = useState<Listener>();
  const [stopping, setStopping] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  useEffect(() => { setConfirmation(undefined); }, [project?.id]);
  async function refresh() {
    if (pending.current) return;
    pending.current = true; const request = ++generation.current;
    setBusy(true); setError(''); setConfirmation(undefined);
    try {
      const result = await invoke<Inventory>('inspect_ports');
      if (mounted.current && request === generation.current) { setInventory(result); setExpanded(undefined); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice('Copied to clipboard.'); }
    catch { setError('Clipboard unavailable. Select and copy the value manually.'); }
  }
  const association = (row: Listener): { project: Project; service: Service } | undefined => {
    for (const item of projects) { const service = item.services.find(service => serviceKey(item.id, service.id) === row.serviceKey); if (service) return { project: item, service }; }
  };
  async function stop(row: Listener) {
    setConfirmation(undefined); setStopping(true); setError('');
    try {
      await invoke('stop_port_service', { serviceKey: row.serviceKey, runToken: row.runToken });
      if (mounted.current) { setNotice('Managed service stop completed.'); await refresh(); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setStopping(false); }
  }
  const rows = inventory?.listeners ?? [];
  const conflicts = rows.filter(row => diagnose(row, project).kind === 'conflict');
  const unknown = rows.filter(row => !row.creationTime || !row.serviceKey).length;
  const query = search.trim().toLowerCase();
  const visible = rows.filter(row => {
    const diagnosis = diagnose(row, project);
    return (family === 'all' || row.family === family)
      && (filter === 'all' || filter === 'selected' && diagnosis.kind === 'managed' || filter === 'managed' && !!row.serviceKey || filter === 'conflicts' && ['potential', 'conflict'].includes(diagnosis.kind))
      && `${row.port} ${row.pid} ${row.name ?? ''} ${row.executable ?? ''} ${row.address}`.toLowerCase().includes(query);
  });
  return <section className="port-manager">
    <header className="page-header"><div><span className="eyebrow">LOCAL NETWORK / TCP</span><h1>Port Manager</h1><p>Find listeners, verify service ownership, and investigate configured ports.</p></div><Button icon={<RefreshCw size={16} />} disabled={busy || stopping} onClick={() => void refresh()}>{busy ? 'Inspecting…' : inventory ? 'Refresh' : 'Inspect ports'}</Button></header>
    <div className="port-project"><label>Project context <select value={project?.id ?? ''} onChange={event => selectProject(event.target.value)}><option value="" disabled>Select a project</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span>No background scanning. Results are a point-in-time snapshot.</span></div>
    {error && <p className="port-error" role="alert">{error}</p>}{notice && <p role="status" className="port-note">{notice}</p>}
    {inventory && <><div className="port-summary">{[
      ['Listening ports', new Set(rows.map(row => row.port)).size],
      ['Verified managed services', new Set(rows.flatMap(row => row.serviceKey ? [row.serviceKey] : [])).size],
      ['Confirmed conflicts', new Set(conflicts.map(row => row.port)).size],
      ['Unknown ownership / errors', unknown + inventory.errors.length],
    ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <p className="port-note">Inspected {new Date(inventory.inspectedAt).toLocaleString()}. {rows.length} listener bindings; all local TCP listeners are included. Unmanaged does not mean stale or unsafe.</p>
    {inventory.errors.map(message => <p className="port-error" role="alert" key={message}>{message}. Availability cannot be established for this family.</p>)}
    {project && <Card className="port-expected"><h2>Configured ports</h2>{project.services.some(service => service.port) ? project.services.filter(service => service.port).map(service => {
      const listeners = rows.filter(row => row.port === service.port && overlap(service.host, row) !== 'none');
      const own = listeners.some(row => row.serviceKey === serviceKey(project.id, service.id));
      const exact = listeners.some(row => overlap(service.host, row) === 'exact');
      return <p key={service.id}><strong>{service.name} · {service.port}</strong><span>{own ? 'Listening in this service’s verified Job Object' : listeners.length ? exact ? 'Relevant listener observed — inspect ownership below' : 'Possible overlap — bind interface unverified' : inventory.errors.length ? 'Inspection incomplete — availability unknown' : 'No overlapping TCP listener observed; availability can change before bind'}</span></p>;
    }) : <p>No explicit ports configured. No ports inferred from commands.</p>}</Card>}
    <div className="port-toolbar"><label className="port-search"><Search size={15} /><input aria-label="Search listeners" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search port, PID, process, or executable" /></label><select aria-label="Listener filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All listeners</option><option value="selected">Selected project</option><option value="managed">Managed</option><option value="conflicts">Potential conflicts</option></select><select aria-label="Address family" value={family} onChange={event => setFamily(event.target.value)}><option value="all">IPv4 + IPv6</option><option>IPv4</option><option>IPv6</option></select></div>
    <div className="port-results" aria-busy={busy}>{visible.map(row => {
      const key = `${row.family}/${row.address}/${row.port}/${row.pid}`; const diagnosis = diagnose(row, project); const owner = association(row);
      return <article key={key} className={`port-entry port-${diagnosis.kind}`}><div className="port-row"><div className="port-number"><Network size={16} /><strong>{row.port}</strong><Button tone="quiet" title="Copy port" aria-label={`Copy port ${row.port}`} onClick={() => void copy(String(row.port))}><Copy size={13} /></Button></div><div className="port-owner"><strong>{row.name ?? 'Process unavailable'}</strong><small>PID {row.pid} · {owner ? `${owner.project.name} / ${owner.service.name}` : row.serviceKey ? 'Verified managed service (configuration unavailable)' : 'Ownership unverified'}</small></div><div className="port-bind"><code>{row.address}</code><small>TCP · {row.family} · LISTEN</small></div><span className="port-status">{labels[diagnosis.kind]}</span><Button aria-expanded={expanded === key} aria-controls={`port-details-${key}`} onClick={() => setExpanded(expanded === key ? undefined : key)}>{expanded === key ? 'Close' : 'Inspect'}</Button></div>
      {expanded === key && <div className="port-details" id={`port-details-${key}`}><p>{diagnosis.message}</p><dl><dt>Executable</dt><dd>{row.executable ?? 'Unavailable due to permissions or process exit'}{row.executable && <Button tone="quiet" onClick={() => void copy(row.executable!)}>Copy path</Button>}</dd><dt>Process ID</dt><dd>{row.pid} <Button tone="quiet" onClick={() => void copy(String(row.pid))}>Copy PID</Button></dd><dt>Identity evidence</dt><dd>{row.inspection}{row.creationTime && <><br />Creation FILETIME: <code>{row.creationTime}</code></>}</dd><dt>Association</dt><dd>{row.serviceKey ? 'Verified membership in a DevFlow-owned Windows Job Object at inspection time.' : 'Not verified as DevFlow-managed. No project inferred from process name, directory, or port.'}</dd>{owner && <><dt>Service configuration</dt><dd>{owner.service.name} · {owner.service.host ?? 'Bind host unspecified'} · configured port {owner.service.port ?? 'unspecified'}<br />Working directory: {owner.service.cwd}</dd></>}</dl>
      <div className="port-stop"><Button tone="danger" disabled={!row.serviceKey || !row.runToken || stopping || busy} onClick={() => setConfirmation(row)}>Stop managed service</Button><p>{row.serviceKey ? 'Stops the entire managed service Job Object, including its child processes. The current run is revalidated before stopping.' : 'Stop disabled: user ownership and development-process authorization are not established. Inspect this executable externally or change your project’s configured port.'}</p></div></div>}</article>;
    })}{!visible.length && <p className="port-empty">{rows.length ? 'No listeners match these filters.' : inventory.errors.length ? 'Inspection unavailable. No availability claims can be made.' : 'No TCP listeners observed at inspection time.'}</p>}</div></>}
    {!inventory && <Card className="port-empty"><Network size={24} /><h2>Inspect your local listeners</h2><p>Use Inspect ports to read Windows TCP ownership information. No processes are started or stopped by inspection.</p></Card>}
    {confirmation && <ConfirmDialog title="Stop managed service?" destructive confirmText="Stop service and children" onCancel={() => setConfirmation(undefined)} onConfirm={() => void stop(confirmation)} description={`Stop ${association(confirmation)?.project.name ?? 'DevFlow project'} / ${association(confirmation)?.service.name ?? confirmation.serviceKey}? Process: ${confirmation.name ?? 'Unknown'}, PID ${confirmation.pid}, TCP port ${confirmation.port}, address ${confirmation.address}. Executable: ${confirmation.executable ?? 'Unavailable'}. This forcibly stops the whole managed service and its children, including other ports it owns; active requests and unsaved process state may be lost. The backend refuses if this service run has changed.`} />}
  </section>;
}
