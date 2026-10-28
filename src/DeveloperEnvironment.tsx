import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Box, Check, Code2, Copy, Database, GitBranch, RefreshCw, Search, Terminal } from 'lucide-react';
import { Button, Card } from './components';
import type { Project } from './types';
import './developer-environment.css';

type Tool = { id: string; name: string; status: 'installed' | 'notFound' | 'checkFailed' | 'unknown'; version: string | null; location: string | null; detail: string };
type Requirement = { ecosystem: string; name: string; constraint: string; installedVersion: string | null; status: 'missing' | 'mismatch' | 'satisfied' | 'unknown'; detail: string };
type Requirements = { ecosystems: string[]; dependencies: Requirement[]; notes: string[] };
const groups = [
  ['Runtimes & package tools', ['node', 'npm', 'pnpm', 'yarn', 'python', 'pip', 'uv', 'rustc', 'cargo', 'go', 'java', 'dotnet']],
  ['Development & service clients', ['git', 'docker', 'psql', 'redis', 'mongo']],
  ['AI CLIs', ['codex', 'claude', 'gemini', 'opencode']],
] as const;
const names: Record<string, string> = { node: 'Node.js', npm: 'npm', pnpm: 'pnpm', yarn: 'Yarn', python: 'Python', pip: 'pip', uv: 'uv', rustc: 'Rust', cargo: 'Cargo', go: 'Go', java: 'Java', dotnet: '.NET', git: 'Git', docker: 'Docker CLI', psql: 'PostgreSQL CLI', redis: 'Redis CLI', mongo: 'MongoDB shell', codex: 'Codex CLI', claude: 'Claude CLI', gemini: 'Gemini CLI', opencode: 'OpenCode CLI' };
const ids = groups.flatMap(([, values]) => [...values]);
const labels: Record<string, string> = { installed: 'Installed', notFound: 'Not found on PATH', checkFailed: 'Check failed', unknown: 'Unknown', missing: 'Missing', mismatch: 'Mismatch', satisfied: 'Satisfied' };
const toolIcon = (id: string) => ['node', 'npm', 'pnpm', 'yarn', 'python', 'pip', 'uv', 'rustc', 'cargo', 'go', 'java', 'dotnet'].includes(id) ? <Code2 size={15} /> : ['psql', 'redis', 'mongo', 'docker'].includes(id) ? <Database size={15} /> : id === 'git' ? <GitBranch size={15} /> : <Terminal size={15} />;
const displayPath = (path: string) => path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
const toolStatus = (tool?: Tool, checking = false) => checking ? 'checking' : tool?.status ?? 'unchecked';

export default function DeveloperEnvironment({ project, projects, selectProject }: { project?: Project; projects: Project[]; selectProject: (id: string) => void }) {
  const [tools, setTools] = useState<Record<string, Tool>>({});
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [dependencyQuery, setDependencyQuery] = useState('');
  const [dependencyFilter, setDependencyFilter] = useState('all');
  const [visibleDependencies, setVisibleDependencies] = useState(50);
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const toolGeneration = useRef(0);
  const projectGeneration = useRef(0);
  useEffect(() => { projectGeneration.current++; setRequirements(null); setError(''); setVisibleDependencies(50); setDependencyQuery(''); setDependencyFilter('all'); }, [project?.id, project?.root]);
  useEffect(() => () => { toolGeneration.current++; projectGeneration.current++; }, []);
  const check = async (id: string, generation = toolGeneration.current) => {
    setBusy(current => [...current, id]);
    try {
      const value = await invoke<Tool>('check_tool', { id });
      if (generation === toolGeneration.current) setTools(current => ({ ...current, [id]: value }));
    } catch { if (generation === toolGeneration.current) setTools(current => ({ ...current, [id]: { id, name: names[id], status: 'checkFailed', version: null, location: null, detail: 'The native check could not be completed.' } })); }
    finally { setBusy(current => current.filter(value => value !== id)); }
  };
  const refreshAll = async () => {
    if (busy.length) return;
    const generation = ++toolGeneration.current;
    setTools({});
    // Three workers cap native probe concurrency without background polling.
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => { while (next < ids.length && generation === toolGeneration.current) { const id = ids[next++]; await check(id, generation); } }));
  };
  const checkProject = async () => {
    if (!project || busy.includes('project')) return;
    const generation = ++projectGeneration.current;
    setRequirements(null); setError(''); setBusy(current => [...current, 'project']);
    try {
      const value = await invoke<Requirements>('check_project_requirements', { projectId: project.id, expectedRoot: project.root });
      if (generation === projectGeneration.current) setRequirements(value);
    } catch (cause) { if (generation === projectGeneration.current) setError(String(cause)); }
    finally { setBusy(current => current.filter(value => value !== 'project')); }
  };
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); window.setTimeout(() => setCopied(''), 2000); }
    catch { setError('Clipboard access failed.'); }
  };
  const diagnostic = () => [
    'DevFlow Developer Environment (explicit checks only)',
    ...ids.map(id => { const t = tools[id]; return `${names[id]}: ${t ? `${labels[t.status]}${t.version ? ` — ${t.version}` : ''}${t.location ? ` (${t.location})` : ''}` : 'Not checked'}`; }),
    `Project: ${project?.name ?? 'None selected'}`,
    ...(requirements ? [`Ecosystems: ${requirements.ecosystems.join(', ') || 'None recognized'}`, ...requirements.dependencies.map(d => `${d.ecosystem}: ${d.name} ${d.constraint} — ${labels[d.status]}${d.installedVersion ? ` (${d.installedVersion})` : ''}`), ...requirements.notes] : ['Project requirements: Not checked']),
    'Unknown means local installation or constraint satisfaction was not safely verified. Service state was not checked.',
  ].join('\n');
  const matches = (text: string, status: string) => text.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || filter === status);
  const counts = ids.reduce((result, id) => { const status = tools[id]?.status; if (status) result[status]++; return result; }, { installed: 0, unknown: 0, notFound: 0, checkFailed: 0 });
  const checkedCount = Object.keys(tools).length;
  const dependencyRows = requirements?.dependencies.filter(item => item.name.toLocaleLowerCase().includes(dependencyQuery.toLocaleLowerCase()) && (dependencyFilter === 'all' || dependencyFilter === item.status)) ?? [];
  const dependencyCounts = (requirements?.dependencies ?? []).reduce((result, item) => { result[item.status]++; return result; }, { satisfied: 0, mismatch: 0, missing: 0, unknown: 0 });
  const compactStatus = (status: string) => <span className={'env-status env-status-' + status}><i aria-hidden="true" />{status === 'checking' ? 'Checking…' : status === 'unchecked' ? 'Not checked' : labels[status] ?? status}</span>;
  const copyPath = (path: string, name: string) => void copy(path, name + ' path');
  return <div className="developer-environment">
    <header className="page-header env-page-header"><div><span className="eyebrow">LOCAL INSPECTION</span><h1>Developer Environment<span className="accent-period">.</span></h1><p>Check installed tools and project dependencies on demand.</p></div><Button icon={<Copy size={15} />} onClick={() => void copy(diagnostic(), 'summary')}>Copy Diagnostic Summary</Button></header>
    {copied && <p role="status" className="env-note"><Check size={15} /> Copied {copied}.</p>}
    {error && <p role="alert" className="env-error">{error}</p>}

    <Card className="env-card env-system-card">
      <div className="env-card-heading"><div><span className="eyebrow">SYSTEM DEVELOPMENT TOOLS</span><h2>Installed tools</h2><p>Version checks use fixed executables on PATH. Client tools do not indicate whether a service is running.</p></div></div>
      <div className="env-summary">{[['Installed', counts.installed, 'installed'], ['Unknown / Unverified', counts.unknown, 'unknown'], ['Not found on PATH', counts.notFound, 'notFound'], ['Check failed', counts.checkFailed, 'checkFailed']].map(([label, count, status]) => <div className={'env-summary-card env-summary-' + status} key={label}><span>{label}</span><strong>{String(count).padStart(2, '0')}</strong></div>)}</div>
      <div className="env-summary-caption">{checkedCount} of {ids.length} tools checked</div>
      <div className="env-toolbar"><label className="env-search"><Search size={16} /><span className="sr-only">Search tools by name, version, or path</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tools, versions, or paths" /></label><label className="env-filter"><span className="sr-only">Filter tools by status</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All statuses</option>{['installed', 'notFound', 'checkFailed', 'unknown'].map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></label><Button className="env-refresh" icon={<RefreshCw size={15} className={busy.some(value => value !== 'project') ? 'env-spinning' : ''} />} disabled={busy.length > 0} onClick={() => void refreshAll()}>{busy.some(value => value !== 'project') ? 'Checking tools…' : 'Refresh All'}</Button></div>
      <div className="env-tool-groups">{groups.map(([heading, group]) => {
        const shown = group.filter(id => matches(names[id] + ' ' + (tools[id]?.version ?? '') + ' ' + (tools[id]?.location ?? ''), tools[id]?.status ?? 'unknown'));
        if (!shown.length) return null;
        return <section className="env-tool-group" key={heading} aria-label={heading}><h3>{heading}<span>{shown.length}</span></h3><div className="env-tool-list">{shown.map(id => {
          const t = tools[id]; const checking = busy.includes(id);
          return <article className={'env-tool-row' + (checking ? ' is-checking' : '')} key={id}>
            <span className="env-tool-icon" aria-hidden="true">{toolIcon(id)}</span><div className="env-tool-name"><strong>{names[id]}</strong><small>{t?.version ?? 'Version not checked'}</small></div><div className="env-tool-status" title={t?.detail}>{compactStatus(toolStatus(t, checking))}</div>
            <div className="env-tool-path" title={t?.location ?? 'Executable location appears after a successful check'}>{t?.location ? displayPath(t.location) : 'Location not checked'}</div>
            <div className="env-tool-actions"><Button className="env-icon-button" title={'Check ' + names[id] + ' version'} aria-label={'Check ' + names[id] + ' version'} disabled={checking || busy.some(value => value !== 'project' && value !== id)} onClick={() => void check(id)}>{checking ? <RefreshCw size={15} className="env-spinning" /> : <RefreshCw size={15} />}</Button><Button className="env-icon-button" title={'Copy ' + names[id] + ' version'} aria-label={'Copy ' + names[id] + ' version'} disabled={!t?.version} onClick={() => t?.version && void copy(t.version, names[id] + ' version')}><Copy size={14} /></Button><Button className="env-icon-button env-path-copy" title={'Copy ' + names[id] + ' executable path'} aria-label={'Copy ' + names[id] + ' executable path'} disabled={!t?.location} onClick={() => t?.location && copyPath(t.location, names[id])}><Box size={14} /></Button></div>
          </article>;
        })}</div></section>;
      })}{!groups.some(([, group]) => group.some(id => matches(names[id] + ' ' + (tools[id]?.version ?? '') + ' ' + (tools[id]?.location ?? ''), tools[id]?.status ?? 'unknown'))) && <div className="env-empty"><Search size={18} /><strong>No tools match these filters</strong><span>Clear the search or choose another status.</span></div>}</div>
    </Card>
    <Card className="env-card env-dependency-card">
      <div className="env-card-heading env-dependency-heading"><div><span className="eyebrow">SELECTED PROJECT</span><h2>Project dependencies</h2><p>Manifest declarations are separate from verified local versions.</p></div><div className="env-project-controls"><label htmlFor="env-project" className="sr-only">Select project</label><select id="env-project" value={project?.id ?? ''} onChange={event => selectProject(event.target.value)}><option value="" disabled>Select a saved project</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><Button disabled={!project || busy.includes('project')} icon={<RefreshCw size={15} className={busy.includes('project') ? 'env-spinning' : ''} />} onClick={() => void checkProject()}>{busy.includes('project') ? 'Checking…' : requirements ? 'Recheck' : 'Check Requirements'}</Button></div></div>
      <p className="env-note env-dependency-note">Unknown means local installation or constraint satisfaction was not verified. Lockfiles may be detected, but their versions are not treated as installed.</p>
      {requirements && <>
        <div className="env-ecosystems">{requirements.ecosystems.length ? requirements.ecosystems.map(item => <span key={item}><Code2 size={13} />{item}</span>) : <span>No recognized ecosystem</span>}</div>
        {requirements.notes.map(note => <p className="env-note env-manifest-note" key={note}>{note}</p>)}
        <div className="env-dependency-summary">{(['satisfied', 'unknown', 'missing', 'mismatch'] as const).map(status => <span className={'env-dependency-count env-status-' + status} key={status}><i />{dependencyCounts[status]} {labels[status]}</span>)}</div>
        <div className="env-dependency-toolbar"><label className="env-search"><Search size={15} /><span className="sr-only">Search dependencies by package name</span><input value={dependencyQuery} onChange={event => { setDependencyQuery(event.target.value); setVisibleDependencies(50); }} placeholder="Search package names" /></label><label className="env-filter"><span className="sr-only">Filter dependencies by verification status</span><select value={dependencyFilter} onChange={event => { setDependencyFilter(event.target.value); setVisibleDependencies(50); }}><option value="all">All statuses</option>{['satisfied', 'unknown', 'missing', 'mismatch'].map(status => <option key={status} value={status}>{labels[status]}</option>)}</select></label></div>
        {dependencyRows.length ? <><div className="env-dependency-list" role="list" aria-label="Project dependencies">{dependencyRows.slice(0, visibleDependencies).map((d, index) => <article className="env-dependency-row" role="listitem" key={d.ecosystem + ':' + d.name + ':' + index} title={d.detail}><span className="env-dependency-ecosystem">{d.ecosystem}</span><strong className="env-dependency-name" title={d.name}>{d.name}</strong><span className="env-dependency-constraint"><small>Declared</small><code>{d.constraint || 'Unspecified'}</code></span><span className="env-dependency-installed"><small>Verified local</small><code>{d.installedVersion ?? 'Unverified'}</code></span>{compactStatus(d.status)}</article>)}</div><div className="env-list-footer"><span>Showing {Math.min(visibleDependencies, dependencyRows.length)} of {dependencyRows.length} matching dependencies</span>{visibleDependencies < dependencyRows.length && <Button onClick={() => setVisibleDependencies(count => count + 50)}>Show 50 more</Button>}</div></> : <div className="env-empty"><Search size={18} /><strong>{requirements.dependencies.length ? 'No dependencies match these filters' : 'No supported dependencies found'}</strong><span>{requirements.dependencies.length ? 'Change the search or status filter.' : 'No supported dependency declarations were found in the project root.'}</span></div>}
      </>}
      {!requirements && <div className="env-empty"><span>{busy.includes('project') ? 'Reading supported manifests…' : project ? 'Run a check to inspect this project’s declarations.' : 'Select a saved project to inspect its dependencies.'}</span></div>}
    </Card>
  </div>;
}
