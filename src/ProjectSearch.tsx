import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Square } from 'lucide-react';
import { editorApi, normalizeText, type ProjectSearchHit, type ProjectSearchOptions, type ProjectSearchResult, type ProjectReplaceFile, type ProjectReplacePreview, type ProjectReplaceOutcome } from './editor-api';
import { ConfirmDialog } from './components';
import { createPortal } from 'react-dom';
import { errorMessage } from './operation-error';
import type { Project } from './types';

export default function ProjectSearch({ project, enabled, focus, dirtyPaths, replace, open }: {
  project: Project; enabled: boolean; focus: number; dirtyPaths: string[];
  replace: (files: ProjectReplaceFile[]) => Promise<ProjectReplaceOutcome>; open: (hit: ProjectSearchHit) => void;
}) {
  const [options, setOptions] = useState<ProjectSearchOptions>({ query: '', caseSensitive: false, wholeWord: false, regex: false, include: '', exclude: '' });
  const [result, setResult] = useState<ProjectSearchResult>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(100);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<string>();
  const generation = useRef(0);
  const [replacement, setReplacement] = useState('');
  const [preview, setPreview] = useState<ProjectReplacePreview>();
  const [preparing, setPreparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [outcome, setOutcome] = useState<ProjectReplaceOutcome>();
  const replaceLock = useRef(false);
  const reviewGeneration = useRef(0);
  const dirtyKey = dirtyPaths.map(path => path.toLowerCase()).sort().join('\0');
  useEffect(() => {
    reviewGeneration.current++; setPreview(undefined); setConfirmReplace(false); setOutcome(undefined);
    return () => { reviewGeneration.current++; };
  }, [options, replacement, dirtyKey, project.id, project.root]);
  const targetPaths = [...new Set(result?.hits.map(hit => hit.path) || [])];
  const dirtyTargets = targetPaths.some(path => dirtyPaths.some(dirty => dirty.toLowerCase() === path.toLowerCase()));
  const reviewReplacement = async () => {
    if (!enabled || busy || dirtyTargets || !targetPaths.length || result?.limited || result?.cancelled || replaceLock.current) return;
    replaceLock.current = true; setPreparing(true); setPreview(undefined); setOutcome(undefined); setError('');
    const version = ++reviewGeneration.current;
    try {
      const value = await editorApi.previewReplace(project, targetPaths, options, replacement);
      if (reviewGeneration.current === version) setPreview(value);
    } catch (cause) { if (reviewGeneration.current === version) setError(errorMessage(cause)); }
    finally { replaceLock.current = false; setPreparing(false); }
  };
  const applyReplacement = async () => {
    if (!enabled || !preview?.files.length || replaceLock.current) return;
    replaceLock.current = true; setConfirmReplace(false); setApplying(true); setError('');
    try { setOutcome(await replace(preview.files)); }
    catch (cause) { setOutcome({ applied: [], error: errorMessage(cause) }); }
    finally { replaceLock.current = false; setApplying(false); setPreview(undefined); setRefresh(value => value + 1); }
  };
  const cancel = (id: string) => {
    void editorApi.cancelSearch(id).catch(cause => setError(`Could not cancel search: ${errorMessage(cause)}`));
  };
  useEffect(() => { input.current?.focus(); }, [focus]);
  useEffect(() => {
    const version = ++generation.current;
    setResult(undefined); setError(''); setStopped(false); setPage(100); setCollapsed(new Set());
    if (!enabled || !options.query) { setBusy(false); return; }
    setBusy(true);
    let id: string | undefined;
    const timer = setTimeout(() => {
      if (generation.current !== version) return;
      id = crypto.randomUUID(); request.current = id;
      void editorApi.search(project, id, options).then(value => {
        if (generation.current === version) setResult(value);
      }).catch(cause => {
        if (generation.current === version) setError(errorMessage(cause));
      }).finally(() => {
        if (generation.current === version) { setBusy(false); request.current = undefined; }
      });
    }, 300);
    return () => {
      clearTimeout(timer); generation.current++;
      if (id) cancel(id);
      request.current = undefined;
    };
  }, [project.id, project.root, options, refresh, enabled]);
  const groups = useMemo(() => {
    const groups = new Map<string, ProjectSearchHit[]>();
    for (const hit of result?.hits.slice(0, page) || []) {
      const group = groups.get(hit.path);
      if (group) group.push(hit); else groups.set(hit.path, [hit]);
    }
    return [...groups];
  }, [result, page]);
  const change = (patch: Partial<ProjectSearchOptions>) => setOptions(current => ({ ...current, ...patch }));
  return <div className="qe-project-search" onContextMenu={event => event.stopPropagation()}>
    <form className="qe-project-search-controls" onSubmit={event => { event.preventDefault(); setRefresh(value => value + 1); }}>
      <label>Find<input ref={input} aria-label="Search project files" placeholder="Search project…" value={options.query} maxLength={1024} disabled={applying} onChange={event => change({ query: event.target.value })} /></label>
      <div className="qe-project-search-options">
        {([['caseSensitive', 'Aa', 'Match case'], ['wholeWord', 'ab', 'Whole word (Unicode word boundaries)'], ['regex', '.*', 'Regular expression (per line; no lookaround or backreferences)']] as const).map(([key, label, title]) => <button key={key} type="button" title={title} aria-label={title} aria-pressed={options[key]} onClick={() => change({ [key]: !options[key] })}>{label}</button>)}
        <button type="submit" disabled={!options.query || busy || !enabled} title="Search again (Enter)" aria-label="Search again"><RefreshCw size={13} /></button>
        {busy && <button type="button" title="Stop search" aria-label="Stop search" onClick={() => { generation.current++; if (request.current) cancel(request.current); request.current = undefined; setBusy(false); setStopped(true); }}><Square size={12} /></button>}
      </div>
      <details><summary>Files to include / exclude</summary>
        <label>Include<input placeholder="src/**, *.ts, *.tsx" value={options.include} maxLength={2048} onChange={event => change({ include: event.target.value })} /></label>
        <label>Exclude<input placeholder="*.test.*, docs/**" value={options.exclude} maxLength={2048} onChange={event => change({ exclude: event.target.value })} /></label>
      </details>
      <details className="qe-project-replace-controls"><summary>Replace across files</summary>
        <label>Replace with<textarea aria-label="Project replacement text" placeholder="Empty text deletes matches" value={replacement} maxLength={4096} rows={2} disabled={applying} onChange={event => setReplacement(event.target.value)} /></label>
        <small>{options.regex ? 'Capture groups: $1, ${name}; $$ inserts a dollar sign.' : 'Replacement text is literal.'}</small>
        <button type="button" disabled={!enabled || busy || preparing || applying || dirtyTargets || !targetPaths.length || result?.limited || result?.cancelled} onClick={() => void reviewReplacement()}>{preparing ? 'Preparing review…' : 'Review replacements'}</button>
        {dirtyTargets && <small>Save or discard unsaved edits in matching files before replacing.</small>}
        {result?.limited && <small>Narrow your search until all matches fit before replacing.</small>}
      </details>
      <small>Saved UTF-8 files · respects ignore rules · skips dependency/build folders. Unsaved drafts are not searched.</small>
    </form>
    <div className="qe-project-search-status" role="status">
      {busy ? <><Loader2 size={13} className="qe-spin" />Searching…</> : stopped ? 'Search stopped.' : result ? `${result.hits.length}${result.limited ? '+' : ''} matches in ${result.files} files · ${result.elapsedMs} ms` : options.query ? '' : 'Find text across this project.'}
      {result && <small>{result.scanned} files searched · {result.skipped} unreadable, binary, oversized or blocked files skipped.{result.limited && ' Limit reached; narrow your query or file filters.'}{result.cancelled && ' Search cancelled; results are partial.'}</small>}
    </div>
    {error && <p className="qe-project-search-error" role="alert">{error}</p>}
    {outcome && <div className="qe-project-search-status" role="status">{outcome.applied.length} files replaced.
      {!!outcome.applied.length && <details><summary>Saved files</summary><ul>{outcome.applied.map(path => <li key={path}>{path}</li>)}</ul></details>}
      {outcome.error && <p className="qe-project-search-error" role="alert">{outcome.error} Replacement stopped; earlier successful saves remain. Refresh and review before retrying.</p>}</div>}
    <div className="qe-project-search-results" aria-label="Project search results" aria-busy={busy}>
      {preview && <section className="qe-project-replace-review" aria-label="Replacement review">
        <strong>{preview.matches} replacements in {preview.files.length} files</strong>
        <p>Changes are saved to disk after confirmation. Saves preserve eligible file history. This batch is not atomic; a failure stops later saves.</p>
        {preview.files.map(file => <details key={file.path}><summary>{file.path} · {file.matches} matches</summary><ReplacementDiff file={file} /></details>)}
        <div className="qe-project-search-options"><button disabled={!enabled || applying || !preview.files.length} onClick={() => setConfirmReplace(true)}>{applying ? 'Replacing…' : 'Replace reviewed files'}</button><button disabled={applying} onClick={() => setPreview(undefined)}>Cancel review</button></div>
        {!preview.files.length && <p>No changes: the replacement already matches the file contents.</p>}
      </section>}
      {groups.map(([path, hits]) => <div key={path}>
        <button className="qe-project-search-file" aria-expanded={!collapsed.has(path)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })}>
          {collapsed.has(path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}<span>{path}</span>
        </button>
        {!collapsed.has(path) && hits.map((hit, index) => <button className="qe-project-search-hit" key={`${hit.line}:${hit.column}:${index}`} disabled={!enabled} title={`${path}:${hit.line}:${hit.column}`} onClick={() => open(hit)}>
          <small>{hit.line}:{hit.column}</small><code>{hit.preview.slice(0, hit.start)}<mark>{hit.preview.slice(hit.start, hit.end) || '▏'}</mark>{hit.preview.slice(hit.end)}</code>
        </button>)}
      </div>)}
      {result && result.hits.length > page && <button className="qe-project-search-more" onClick={() => setPage(value => value + 100)}>Show next 100 matches ({result.hits.length - page} remaining)</button>}
    </div>
    {confirmReplace && preview && createPortal(<ConfirmDialog title="Replace project text?" description={`Save ${preview.matches} replacements in ${preview.files.length} files in ${project.name}? Files are checked against this review before saving. Earlier successful saves remain if a later file fails.`} confirmText={`Replace ${preview.files.length} files`} destructive onConfirm={() => void applyReplacement()} onCancel={() => setConfirmReplace(false)} />, document.body)}
  </div>;
}

function ReplacementDiff({ file }: { file: ProjectReplaceFile }) {
  const before = normalizeText(file.expected.content).split('\n');
  const after = normalizeText(file.content).split('\n');
  let first = 0;
  while (first < before.length && first < after.length && before[first] === after[first]) first++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > first && newEnd > first && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const excerpt = (lines: string[], end: number) => lines.slice(first, Math.min(end, first + 20)).map(line => line.length > 240 ? `${line.slice(0, 240)}…` : line).join('\n') + (end > first + 20 ? '\n…' : '');
  return <div className="qe-project-replace-diff"><small>Changed text excerpt from line {first + 1} (up to 20 lines per side)</small><span>Before</span><pre>{excerpt(before, oldEnd) || '(empty)'}</pre><span>After</span><pre>{excerpt(after, newEnd) || '(empty)'}</pre></div>;
}
