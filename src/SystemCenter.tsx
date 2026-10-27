import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Cpu, HardDrive, RefreshCw, Search, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { Button, Card, ConfirmDialog, EmptyState } from './components';
import { systemApi, type CleanupCategory, type CleanupResult, type SystemProcess, type SystemSnapshot, type TempPreview } from './system-api';

const bytes = (value: number | null) => {
  if (value === null) return 'Unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
};
const percent = (value: number | null) => value === null ? 'Unavailable' : `${value.toFixed(1)}%`;
const processKind = (name: string) => {
  if (/^(chrome|msedge|firefox|brave|opera|vivaldi)\.exe$/i.test(name)) return 'Browser';
  if (/^(code|cursor|devenv|idea64|pycharm64|webstorm64|sublime_text|notepad\+\+)\.exe$/i.test(name)) return 'Editor';
  if (/^(node|python[\d.]*|cargo|rustc|go|java|dotnet|deno|bun|git|npm|pnpm|uv)\.exe$/i.test(name)) return 'Development';
  return '';
};
function History({ values, label }: { values: (number | null)[]; label: string }) {
  if (!values.some(value => value !== null)) return <p className="system-history-empty">Collecting samples…</p>;
  // Gaps remain gaps; unavailable values are never plotted as zero.
  const segments: string[] = []; let segment: string[] = [];
  values.forEach((value, index) => {
    if (value === null) { if (segment.length) segments.push(segment.join(' ')); segment = []; }
    else segment.push(`${index * 200 / 29},${40 - value * .38}`);
  });
  if (segment.length) segments.push(segment.join(' '));
  return <svg className="system-history" viewBox="0 0 200 42" role="img" aria-label={`${label}, up to 30 recent samples, scale 0 to 100 percent`} preserveAspectRatio="none">{segments.map((points, index) => <polyline key={index} points={points} />)}</svg>;
}
type Confirmation = { title: string; description: string; confirmText: string; destructive?: boolean; execute: () => Promise<void> };
type SortKey = 'cpu' | 'memory' | 'name' | 'pid';

export function SystemCenter({ active, section, onSection, onProjects }: { active: boolean; section: 'system' | 'maintenance'; onSection: (value: 'system' | 'maintenance') => void; onProjects: () => void }) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [history, setHistory] = useState<{ cpu: number | null; ram: number }[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [monitorError, setMonitorError] = useState('');
  const [message, setMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const [operation, setOperation] = useState<'scan' | 'clean' | 'end' | 'dns' | 'tool' | null>(null);
  const operationLock = useRef(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [preview, setPreview] = useState<TempPreview | null>(null);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'cpu', ascending: false });
  const [page, setPage] = useState(0);
  const [previewPage, setPreviewPage] = useState(0);
  const [gpuIndex, setGpuIndex] = useState(0);
  const [paused, setPaused] = useState(document.hidden);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const refreshRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const processHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // One timer and one in-flight request for both tabs. No setInterval backlog.
  useEffect(() => {
    if (!active) { setPaused(true); setConfirmation(null); return; }
    setPaused(document.hidden);
    setHistory([]);
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (force = false) => {
      if (disposed || document.hidden) return;
      if (inFlight.current) { clearTimeout(timer); timer = setTimeout(() => void refresh(force), 2000); return; }
      clearTimeout(timer);
      const requestGeneration = generation.current;
      inFlight.current = true; setRefreshing(true);
      try {
        const value = await systemApi.snapshot(force);
        if (!disposed && !document.hidden && requestGeneration === generation.current) {
          setSnapshot(value); setMonitorError('');
          const ram = value.memoryTotal ? (value.memoryTotal - value.memoryAvailable) / value.memoryTotal * 100 : 0;
          setHistory(current => [...current, { cpu: value.cpu, ram }].slice(-30));
        }
      } catch (error) { if (!disposed && !document.hidden && requestGeneration === generation.current) setMonitorError(String(error)); }
      finally {
        inFlight.current = false;
        if (!disposed) {
          setRefreshing(false);
          if (!document.hidden) timer = setTimeout(() => void refresh(), 2000);
        }
      }
    };
    refreshRef.current = refresh;
    const visibility = () => {
      generation.current += 1; clearTimeout(timer); setPaused(document.hidden);
      if (!document.hidden) { setHistory([]); void refresh(true); }
    };
    document.addEventListener('visibilitychange', visibility);
    // A StrictMode remount may still have a previous read-only request finishing.
    timer = setTimeout(() => void refresh(true), 0);
    return () => { disposed = true; generation.current += 1; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [active]);

  const run = useCallback(async (kind: NonNullable<typeof operation>, task: () => Promise<void>) => {
    if (operationLock.current) return;
    operationLock.current = true; setOperation(kind); setOperationError(''); setMessage('');
    try { await task(); } catch (error) { if (mounted.current) setOperationError(String(error)); }
    finally { operationLock.current = false; if (mounted.current) setOperation(null); }
  }, []);
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    setCancelling(true);
    try { await systemApi.cancel(); if (mounted.current) setMessage('Cancellation requested. Completed deletions cannot be undone.'); }
    catch (error) { if (mounted.current) setOperationError(String(error)); }
    finally { if (mounted.current) setCancelling(false); }
  };
  const processes = useMemo(() => {
    const search = deferredQuery.trim().toLowerCase();
    return (snapshot?.processes || []).filter(process => !search || process.name.toLowerCase().includes(search) || String(process.pid).includes(search)).sort((left, right) => {
      const a = left[sort.key]; const b = right[sort.key];
      if (a === null) return b === null ? left.pid - right.pid : 1;
      if (b === null) return -1;
      const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b);
      return (sort.ascending ? comparison : -comparison) || left.pid - right.pid;
    });
  }, [snapshot, deferredQuery, sort]);
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(processes.length / 100) - 1));
  const processPage = processes.slice(pageIndex * 100, (pageIndex + 1) * 100);
  const selectedBytes = preview?.categories.reduce((sum, category) => sum + (selectedCategories.has(category.id) ? category.bytes : 0), 0) || 0;
  const ram = snapshot && snapshot.memoryTotal ? (snapshot.memoryTotal - snapshot.memoryAvailable) / snapshot.memoryTotal * 100 : null;
  const gpu = snapshot?.gpus[Math.min(gpuIndex, Math.max(0, snapshot.gpus.length - 1))] || null;
  useEffect(() => { setGpuIndex(current => Math.min(current, Math.max(0, (snapshot?.gpus.length || 1) - 1))); }, [snapshot?.gpus.length]);
  const busy = operation !== null;
  const sortBy = (key: SortKey) => { setSort(current => ({ key, ascending: current.key === key ? !current.ascending : key === 'name' || key === 'pid' })); setPage(0); };
  const endTask = (process: SystemProcess) => setConfirmation({ title: `End ${process.name}?`, description: `PID ${process.pid} · ${process.path || 'Path unavailable'}. Unsaved work may be lost. This forcibly terminates only this process. Identity, creation time, ownership, protection, and Job Object membership will be rechecked before termination.`, confirmText: 'End selected task', destructive: true, execute: () => run('end', async () => { const text = await systemApi.endTask(process); if (mounted.current) { setMessage(text); await refreshRef.current(); } }) });
  const scan = () => void run('scan', async () => {
    setPreview(null); setResult(null); setSelectedCategories(new Set()); setPreviewPage(0);
    const value = await systemApi.scanCleanup();
    if (mounted.current) { setPreview(value); setSelectedCategories(new Set(value.categories.filter(category => category.status === 'supported' && category.candidateCount > 0).map(category => category.id))); setMessage(`Scan complete: ${value.files.length} candidates; no files deleted.`); }
  });
  const clean = () => {
    if (!preview || !selectedCategories.size) return;
    const scanId = preview.id; const categories = [...selectedCategories];
    const selectedDetails = preview.categories.filter(category => selectedCategories.has(category.id));
    setConfirmation({ title: 'Delete selected cleanup categories?', description: `${selectedDetails.map(category => `${category.name}: ${category.candidateCount} candidates (${bytes(category.bytes)})`).join(' · ')}. Only unchanged, eligible files in approved user Temp roots will be deleted. Unsupported and Windows-managed categories are never deleted by DevFlow. Actual disk savings can differ.`, confirmText: 'Delete selected files', destructive: true, execute: () => run('clean', async () => {
      setPreview(null); setSelectedCategories(new Set());
      const value = await systemApi.cleanSelectedCleanup(scanId, categories);
      if (mounted.current) { setResult(value); setMessage('Cleanup finished. Review the results below.'); await refreshRef.current(true); }
    }) });
  };
  const focusProcesses = () => { onSection('system'); window.setTimeout(() => { processHeading.current?.focus(); processHeading.current?.scrollIntoView({ block: 'start' }); }, 0); };

  return <div className="system-center" hidden={!active}>
    <header className="page-header"><div><span className="eyebrow">WINDOWS / LOCAL SYSTEM</span><h1>{section === 'system' ? 'System Monitor' : 'Maintenance'}<span className="accent-period">.</span></h1><p>{section === 'system' ? 'Real measurements. Find what is using your computer.' : 'Targeted troubleshooting, with a preview before deletion.'}</p></div><Button icon={<RefreshCw size={15} />} disabled={refreshing || paused} onClick={() => void refreshRef.current(true)} title="Re-query CPU, RAM, processes, and local drives. Does not clear memory or optimize Windows.">{refreshing ? 'Refreshing…' : 'Refresh now'}</Button></header>
    <div className="system-tabbar" role="group" aria-label="System tools"><button aria-pressed={section === 'system'} onClick={() => onSection('system')}>Monitor & processes</button><button aria-pressed={section === 'maintenance'} onClick={() => onSection('maintenance')}>Maintenance</button><span>{paused ? 'Paused while hidden' : 'Samples about every 2 seconds'}{snapshot && ` · Updated ${new Date(snapshot.sampledAt).toLocaleTimeString()}`}</span></div>
    {monitorError && <div className="system-alert" role="alert">Metrics could not refresh: {monitorError}. {snapshot ? 'The last snapshot below may be stale.' : 'No measurements are available yet.'}</div>}
    {operationError && <div className="system-alert" role="alert">{operationError}</div>}
    {message && <p className="system-message" role="status">{message}</p>}
    {operation && <p className="system-operation" role="status">{({ scan: 'Scanning temporary-file metadata…', clean: 'Deleting confirmed temporary files…', end: 'Revalidating and ending the selected process…', dns: 'Waiting for Windows DNS flush…', tool: 'Requesting the Windows storage tool…' })[operation]}{(operation === 'scan' || operation === 'clean') && section === 'system' && <Button tone="quiet" onClick={() => onSection('maintenance')}>View progress / cancel</Button>}</p>}
    {!snapshot && !monitorError && <p role="status">Reading Windows system information…</p>}
    {section === 'system' && <>
      <div className="system-metrics">
        <Card className="system-metric"><span className="system-metric-label"><Cpu size={16} />CPU</span><strong>{percent(snapshot?.cpu ?? null)}</strong><span>{snapshot ? `${snapshot.logicalProcessors} logical processors · ${snapshot.cpuName}` : 'Waiting for Windows'}</span><History values={history.map(point => point.cpu)} label="CPU utilization" /><small>{snapshot?.cpu === null ? 'Needs two samples; aggregate unavailable above 64 processors.' : (snapshot?.cpu || 0) >= 85 ? 'High use in this sample' : 'Measured utilization; not a health score'}</small></Card>
        <Card className="system-metric"><span className="system-metric-label"><Activity size={16} />Memory</span><strong>{percent(ram)}</strong><span>{snapshot ? `${bytes(snapshot.memoryTotal - snapshot.memoryAvailable)} used / ${bytes(snapshot.memoryTotal)} total` : 'Waiting for Windows'}</span><History values={history.map(point => point.ram)} label="Physical memory utilization" /><small>{snapshot ? `${bytes(snapshot.memoryAvailable)} available · ${(ram || 0) >= 85 ? 'High utilization' : 'Physical RAM'}` : 'Unavailable'}</small></Card>
        <Card className="system-metric"><span className="system-metric-label"><Cpu size={16} />GPU</span><strong>{snapshot ? gpu ? percent(gpu.utilization) : 'Unavailable' : '—'}</strong>{snapshot && snapshot.gpus.length > 1 && <label className="project-picker">ADAPTER<select value={gpuIndex} onChange={event => setGpuIndex(Number(event.target.value))}>{snapshot.gpus.map((adapter, index) => <option key={`${adapter.name}-${index}`} value={index}>{adapter.name}</option>)}</select></label>}<span>{gpu?.name || snapshot?.gpuError || (snapshot ? 'No hardware GPU adapter reported by Windows' : 'Waiting for Windows')}</span>{gpu && <><p>{gpu.dedicatedUsed !== null ? gpu.dedicatedTotal !== null ? `${bytes(gpu.dedicatedUsed)} dedicated used / ${bytes(gpu.dedicatedTotal)} physical dedicated capacity` : `${bytes(gpu.dedicatedUsed)} dedicated used · capacity unavailable` : 'Dedicated memory usage unavailable'}</p><p>{gpu.sharedUsed !== null ? gpu.sharedTotal !== null ? `${bytes(gpu.sharedUsed)} shared used / ${bytes(gpu.sharedTotal)} maximum shared allocation` : `${bytes(gpu.sharedUsed)} shared used · maximum unavailable` : 'Shared memory usage unavailable'}</p></>}<small>{gpu?.note || (gpu?.utilization === null ? 'Utilization needs another supported Windows counter sample' : 'Peak busy hardware engine · no temperature estimate')}</small></Card>
        <Card className="system-metric"><span className="system-metric-label"><HardDrive size={16} />Local drives</span><strong>{snapshot?.drivesError ? 'Unavailable' : snapshot ? snapshot.drives.length : '—'}</strong><span>Fixed local drive letters</span><p>{snapshot ? `${snapshot.processes.length.toLocaleString()} processes · Uptime ${Math.floor(snapshot.uptimeSeconds / 86400)}d ${Math.floor(snapshot.uptimeSeconds % 86400 / 3600)}h ${Math.floor(snapshot.uptimeSeconds % 3600 / 60)}m` : 'Waiting for Windows'}</p><small>Drive information cached up to 60 seconds</small></Card>
      </div>
      {snapshot && <Card className="system-storage"><div className="panel-heading"><h2>Storage capacity</h2><small>Last drive query {snapshot.drivesAgeSeconds}s ago</small></div><div className="system-drive-grid">{snapshot.drivesError ? <p role="status">{snapshot.drivesError}</p> : snapshot.drives.length ? snapshot.drives.map(drive => <div className="system-drive" key={drive.name}><strong>{drive.name}</strong>{drive.error ? <p>{drive.error}</p> : <><meter min={0} max={drive.total || 1} value={(drive.total || 0) - (drive.free || 0)} aria-label={`Used space on ${drive.name}`} /><span>{bytes((drive.total || 0) - (drive.free || 0))} used · {bytes(drive.free)} free / {bytes(drive.total)}</span></>}</div>) : <p>No fixed drive letters were available.</p>}</div></Card>}
      {((snapshot?.cpu || 0) >= 85 || (ram || 0) >= 85) && <Card className="system-advice"><h2>Investigate sustained usage</h2><p>A busy CPU can mean builds, indexing, browser tabs, or background work. High RAM utilization can lead to paging; check which applications are using memory and save work before closing them. A single high sample does not establish a fault.</p><Button tone="quiet" onClick={focusProcesses}>Inspect processes</Button></Card>}
      <Card className="system-processes"><div className="panel-heading"><div><span className="eyebrow">RESOURCE USAGE</span><h2 ref={processHeading} tabIndex={-1}>Processes <span className="heading-count">{processes.length}</span></h2></div><label className="search-field"><Search size={15} /><span className="sr-only">Search by process name or PID</span><input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Process name or PID" /></label></div><p className="system-table-note">CPU is normalized across all logical processors. Memory is working set; shared pages may appear in multiple processes. Unavailable values are not zero.</p>
        <div className="system-table-scroll" tabIndex={0} aria-label="Scrollable process table"><table className="system-table"><thead><tr>{([['name', 'Process'], ['pid', 'PID'], ['cpu', 'CPU'], ['memory', 'RAM']] as const).map(([key, title]) => <th key={key} scope="col" aria-sort={sort.key === key ? sort.ascending ? 'ascending' : 'descending' : 'none'}><button onClick={() => sortBy(key)}>{title}{sort.key === key && (sort.ascending ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}<th scope="col">Executable / action</th></tr></thead><tbody>{processPage.map(process => <tr key={`${process.pid}-${process.created || 'unknown'}`}><td><strong>{process.name}</strong>{processKind(process.name) && <small>{processKind(process.name)}</small>}</td><td>{process.pid}</td><td>{percent(process.cpu)}</td><td>{bytes(process.memory)}</td><td><div className="system-process-action"><span title={process.path || 'Path inaccessible or process exited'}>{process.path || 'Path unavailable'}</span><Button tone="quiet" icon={<Square size={12} />} disabled={busy || !process.created || Boolean(process.denyReason)} title={process.denyReason || 'Force end only this process; confirmation required'} onClick={() => endTask(process)}>End task</Button></div>{process.denyReason && <small>{process.denyReason}</small>}</td></tr>)}</tbody></table>{!processes.length && <EmptyState icon={<Search size={22} />} title={query ? 'No matching processes' : 'No process data'} description={query ? 'Try a different process name or PID.' : 'Refresh the monitor to query Windows.'} />}</div>
        <div className="system-pagination"><Button tone="quiet" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous</Button><span>{processes.length ? `${pageIndex * 100 + 1}–${Math.min((pageIndex + 1) * 100, processes.length)} of ${processes.length}` : '0 processes'} · maximum 100 rows per page</span><Button tone="quiet" disabled={(pageIndex + 1) * 100 >= processes.length} onClick={() => setPage(pageIndex + 1)}>Next</Button></div><div className="system-managed-note"><ShieldCheck size={16} /><span>DevFlow and Windows processes are protected. All Job Object members are excluded, including managed services.</span><Button tone="quiet" onClick={onProjects}>Open project controls</Button></div>
      </Card>
    </>}
    {section === 'maintenance' && <div className="maintenance-grid">
      <Card className="maintenance-card maintenance-cleanup"><div className="panel-heading"><div><span className="eyebrow">PREVIEW REQUIRED · PERMANENT DELETION</span><h2>Cleanup center</h2></div><Trash2 size={20} /></div><p>Scan each category independently. DevFlow only automatically deletes eligible old temporary files from the current user's Temp folder; all other categories remain clearly marked as unsupported or Windows-managed.</p><p className="system-table-note">Scans expire after five minutes and are single-use. File lengths are estimates, not promised disk savings. Cleanup never promises improved performance.</p><div className="toolbar-actions"><Button icon={<Search size={15} />} disabled={busy} onClick={scan}>{operation === 'scan' ? 'Scanning…' : 'Scan cleanup categories'}</Button><Button tone="danger" disabled={busy || !selectedCategories.size || !preview} onClick={clean}>Clean selected ({selectedCategories.size})</Button>{(operation === 'scan' || operation === 'clean') && <Button disabled={cancelling} onClick={() => void cancel()}>{cancelling ? 'Requesting…' : 'Cancel operation'}</Button>}</div>
        {operation && ['scan', 'clean'].includes(operation) && <p role="status">{operation === 'scan' ? 'Inspecting directory entries and file metadata…' : 'Revalidating and deleting selected candidates…'} Cancellation is checked between files.</p>}
        {preview && <div className="cleanup-category-list">{preview.categories.map((category: CleanupCategory) => <label key={category.id} className={`cleanup-category cleanup-category-${category.status}`}><input type="checkbox" disabled={busy || category.status !== 'supported' || category.candidateCount === 0} checked={selectedCategories.has(category.id)} onChange={event => setSelectedCategories(current => { const next = new Set(current); if (event.target.checked) next.add(category.id); else next.delete(category.id); return next; })} /><span><strong>{category.name}</strong><small>{category.description}</small><small>{category.safety}{category.note ? ` · ${category.note}` : ''}</small></span><b>{category.status === 'supported' ? `${category.candidateCount} · ${bytes(category.bytes)}` : category.status === 'managed' ? 'Windows-managed' : 'Unsupported'}</b></label>)}</div>}
        {preview && <p className="cleanup-total"><strong>{selectedCategories.size ? `${bytes(selectedBytes)} selected reclaimable space` : 'No cleanup category selected'}</strong> · {preview.skipped} entries excluded or inaccessible.{preview.limited && ' Scan capped at 1,000 candidates or 10,000 entries.'}</p>}
        {preview && <div className="temp-preview"><p><strong>{preview.files.length} candidates · {bytes(preview.files.reduce((sum, file) => sum + file.bytes, 0))}</strong><br /><span className="system-path">{preview.root}</span><br />{preview.skipped} entries excluded or inaccessible.{preview.limited && ' Scan capped at 1,000 candidates or 10,000 entries; additional entries were not inspected.'}</p>{preview.files.length ? <><p className="system-table-note">Candidate files in the supported User temporary files category. Category checkboxes above control cleanup selection.</p><div className="temp-file-list">{preview.files.slice(previewPage * 100, (previewPage + 1) * 100).map(file => <div key={file.id} className="temp-file-row"><span>{file.path}</span><small>{bytes(file.bytes)}</small></div>)}</div><div className="system-pagination"><Button tone="quiet" disabled={previewPage === 0} onClick={() => setPreviewPage(value => value - 1)}>Previous files</Button><span>Page {previewPage + 1} / {Math.ceil(preview.files.length / 100)}</span><Button tone="quiet" disabled={(previewPage + 1) * 100 >= preview.files.length} onClick={() => setPreviewPage(value => value + 1)}>Next files</Button></div></> : <p>No eligible old temporary files found. Nothing to delete.</p>}</div>}
        {result && <div className="maintenance-results" role="status"><h3>{result.cancelled ? 'Cleanup cancelled · partial results' : 'Cleanup results'}</h3><p>{result.removed} files deleted · {bytes(result.bytesRemoved)} in removed file lengths · {result.skipped} selected files skipped or left unprocessed. Actual free-space change may differ due to compression, allocation, and other activity.</p>{result.details.length > 0 && <details><summary>Skipped file details (up to 30)</summary><ul>{result.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul></details>}</div>}
      </Card>
      <Card className="maintenance-card"><span className="eyebrow">LOW RISK · WINDOWS TOOLS</span><h2>Storage tools</h2><p>Open Windows Storage Settings or Disk Cleanup to review Windows-managed categories. DevFlow does not delete Windows Update caches, restore points, driver packages, Downloads, or Recycle Bin contents.</p>{snapshot?.drivesError && <p>{snapshot.drivesError}</p>}{snapshot && <ul className="maintenance-drive-list">{snapshot.drives.map(drive => <li key={drive.name}><strong>{drive.name}</strong> {drive.error || `${bytes(drive.free)} free / ${bytes(drive.total)} total`}</li>)}</ul>}<div className="toolbar-actions"><Button disabled={busy} onClick={() => void run('tool', async () => { const text = await systemApi.storage('settings'); if (mounted.current) setMessage(text); })}>Storage settings</Button><Button disabled={busy} onClick={() => void run('tool', async () => { const text = await systemApi.storage('disk-cleanup'); if (mounted.current) setMessage(text); })}>Windows Disk Cleanup</Button></div></Card>
      <Card className="maintenance-card"><span className="eyebrow">NETWORK TROUBLESHOOTING · LOW RISK</span><h2>Flush DNS cache</h2><p>Run Windows ipconfig /flushdns to clear the local DNS resolver cache. Subsequent requests resolve names again. This may need appropriate permissions and does not accelerate CPU or RAM. DevFlow never requests elevation.</p><Button disabled={busy} onClick={() => setConfirmation({ title: 'Flush Windows DNS cache?', description: 'Clear cached DNS name resolutions using the Windows system ipconfig.exe /flushdns command. Active applications may need to resolve names again. No CPU or RAM optimization is performed.', confirmText: 'Flush DNS cache', execute: () => run('dns', async () => { const text = await systemApi.flushDns(); if (mounted.current) setMessage(text); }) })}>{operation === 'dns' ? 'Flushing…' : 'Flush DNS cache'}</Button></Card>
      <Card className="maintenance-card"><span className="eyebrow">GUIDANCE ONLY · DISPLAY TROUBLESHOOTING</span><h2>GPU driver recovery</h2><p>For a graphics or display problem, Windows provides <kbd>Win</kbd> + <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd>. The display may flicker briefly. Save work when possible before troubleshooting.</p><p>This is a recovery shortcut, not a gaming performance boost. DevFlow only reads supported Windows GPU counters; it does not simulate the shortcut, reset a GPU, or restart a driver.</p></Card>
      <Card className="maintenance-card"><span className="eyebrow">READ ONLY · NO OPTIMIZATION</span><h2>Refresh system metrics</h2><p>Refresh Now queries current resource measurements and bypasses the drive cache. CPU requires two samples. Refresh does not clear RAM, trim another process's memory, restart services, or change Windows settings.</p><Button icon={<RefreshCw size={15} />} disabled={refreshing || paused} onClick={() => void refreshRef.current(true)}>Refresh now</Button></Card>
      <Card className="maintenance-card"><span className="eyebrow">INVESTIGATE FIRST</span><h2>Resource troubleshooting</h2><p>Inspect CPU and RAM usage over several samples. Browser tabs, build tools, indexing, and editors can use significant resources. Save work and close applications normally first. Only eligible processes offer confirmed End Task.</p><Button onClick={focusProcesses}>Inspect high-resource processes</Button><p className="system-table-note">No automatic task killing, RAM cleaners, registry cleaners, or service disabling.</p></Card>
    </div>}
    {active && confirmation && <ConfirmDialog title={confirmation.title} description={confirmation.description} confirmText={confirmation.confirmText} destructive={confirmation.destructive} onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.execute; setConfirmation(null); void action(); }} />}
  </div>;
}
