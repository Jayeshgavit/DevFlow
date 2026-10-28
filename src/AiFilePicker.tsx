import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry, CopyExport } from './editor-api';
import { safeAiContext, formatAttachments, attachmentDuplicate, type AiAttachment } from './ai-context';
export default function AiFilePicker({ projectId, projectRoot, attachments, onChange }: { projectId: string; projectRoot: string; attachments: AiAttachment[]; onChange: (items: AiAttachment[]) => void }) {
  const alive = useRef(true);
  const latest = useRef(attachments); latest.current = attachments;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [folder, setFolder] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => { let disposed = false; setEntries([]); setError('');
    if (!browsing) return;
    void invoke<FileEntry[]>('editor_list', { projectId, expectedRoot: projectRoot, path: folder }).then(rows => { if (!disposed) setEntries(rows.filter(row => !row.blocked)); }).catch(() => { if (!disposed) setError('Could not list this folder.'); });
    return () => { disposed = true; };
  }, [projectId, projectRoot, folder, browsing]);
  useEffect(() => {
    const term = query.trim().toLowerCase(); if (!browsing || !term) { setSearching(false); return; }
    let cancelled = false; setSearching(true);
    void (async () => {
      const queue = ['']; const seen = new Set<string>(); const found: FileEntry[] = []; let scanned = 0;
      while (queue.length && queue.length + seen.size < 120 && scanned < 2400 && !cancelled) {
        const path = queue.shift()!; if (seen.has(path)) continue; seen.add(path);
        try { const rows = await invoke<FileEntry[]>('editor_list', { projectId, expectedRoot: projectRoot, path }); scanned += rows.length;
          for (const row of rows) { if (row.blocked) continue; if (row.directory) { if (!/^(node_modules|\.git|dist|build|target|coverage|\.next|vendor|\.venv|venv|__pycache__)$/i.test(row.name)) queue.push(row.path); }
            else if (row.path.toLowerCase().includes(term) && /\.(tsx?|jsx?|mjs|cjs|py|rs|json|css|html|md|toml|ya?ml|sql)$/i.test(row.path) && !/(^|\/)(\.env[^/]*|[^/]*(secret|credential|private.?key)[^/]*|id_rsa[^/]*|id_ed25519[^/]*)$/i.test(row.path)) found.push(row);
          }
        } catch { /* A guarded folder may become unavailable while browsing. */ }
      }
      if (!cancelled) setEntries(found.slice(0, 200));
    })().finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [query, projectId, projectRoot, browsing]);
  const add = async () => { setBusy(true); setError(''); try {
    const next = [...attachments];
    for (const path of selected) {
      const result = await invoke<CopyExport>('editor_export', { projectId, expectedRoot: projectRoot, path, mode: 'file' });
      const content = safeAiContext(result.text);
      if (result.warnings.length || !result.files || !content.trim()) throw new Error('A selected file is excluded or empty.');
      const candidate = { projectId, kind: 'file' as const, label: path, sourcePath: path, content };
      if (!attachmentDuplicate(next, candidate)) next.push({ ...candidate, id: crypto.randomUUID() });
    }
    if (!alive.current) return;
    if (latest.current !== attachments) throw new Error('Attachments changed; retry selection.');
    formatAttachments(next); onChange(next); setSelected([]);
  } catch (cause) { setError(`Unable to attach selection: ${cause instanceof Error ? cause.message : String(cause)}`); } finally { setBusy(false); } };
  return <details className="qe-ai-file-picker" onToggle={event => setBrowsing(event.currentTarget.open)}><summary>Browse Project Files</summary>
    <input aria-label="Search project files" placeholder="Search project files…" value={query} onChange={event => setQuery(event.target.value)} />
    <button type="button" disabled={busy || !folder} onClick={() => setFolder(folder.replace(/[/\\]?[^/\\]+$/, ''))}>Parent folder</button>
    <div className="qe-ai-file-list">{searching && <span>Searching folders…</span>}{entries.filter(row => (query ? !row.directory : row.path.toLowerCase().includes(query.toLowerCase()))).map(row => row.directory ? <button type="button" disabled={busy} key={row.path} onClick={() => setFolder(row.path)}>{row.path}/</button> : <label key={row.path}><input type="checkbox" disabled={busy} checked={selected.includes(row.path)} onChange={event => setSelected(old => event.target.checked ? [...old, row.path] : old.filter(path => path !== row.path))} />{row.path} <small>{typeof row.size === 'number' ? `${(row.size / 1024).toFixed(1)} KB` : 'size unavailable'}</small></label>)}</div>
    <button type="button" disabled={busy || !selected.length} onClick={() => void add()}>{busy ? 'Reading…' : `Attach selected (${selected.length})`}</button>
    {error && <p role="alert">{error}</p>}
  </details>;
}
