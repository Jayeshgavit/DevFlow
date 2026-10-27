import { errorMessage } from './operation-error';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from './components';
import { editorApi, type FileComparison, type FileHistory, type FileVersion } from './editor-api';
import type { Project } from './types';

export default function EditorHistory({ project, path, dirty, close, restore }: {
  project: Project; path: string; dirty: boolean; close: () => void;
  restore: (id: string, expected: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<FileHistory>();
  const [version, setVersion] = useState<FileVersion>();
  const [comparison, setComparison] = useState<FileComparison>();
  const [mode, setMode] = useState<'preview' | 'compare'>('preview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const operation = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    let disposed = false;
    setError(''); setHistory(undefined); setComparison(undefined); setVersion(undefined);
    void editorApi.history(project, path).then(value => { if (!disposed) { setHistory(value); setError(''); } }).catch(cause => { if (!disposed) setError(`Could not load file history: ${errorMessage(cause)}`); });
    return () => { disposed = true; request.current++; previous?.focus(); };
  }, [project.id, project.root, path]);

  const show = async (item: FileVersion, nextMode: 'preview' | 'compare') => {
    if (operation.current) return;
    const generation = ++request.current;
    setBusy(true); setError(''); setComparison(undefined); setVersion(item); setMode(nextMode);
    try { const value = await editorApi.snapshot(project, path, item.id); if (generation === request.current) setComparison(value); }
    catch (cause) { if (generation === request.current) setError(errorMessage(cause)); }
    finally { if (generation === request.current) setBusy(false); }
  };
  const apply = async () => {
    if (!version || !comparison || dirty || operation.current) return;
    operation.current = true; setConfirm(false); setBusy(true); setError('');
    try { await restore(version.id, comparison.current.content); close(); }
    catch (cause) { setError(errorMessage(cause)); setComparison(undefined); }
    finally { operation.current = false; setBusy(false); }
  };
  return createPortal(<div className="dialog-backdrop"><div ref={dialog} className="dialog qe-history" role="dialog" aria-modal="true" aria-labelledby="qe-history-title" onKeyDown={event => {
    if (confirm) return;
    if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
  }}><header><h2 id="qe-history-title">File history</h2><button ref={closeButton} className="button" disabled={busy} onClick={close}>Close</button></header>
    <p className="qe-history-path">{project.root} / {path}</p>
    <p>{history?.limitation || 'Reading local snapshot history…'}</p>
    {dirty && <p role="status">This file has unsaved edits. Close History and save or discard them before restoring.</p>}
    {error && <p role="alert" className="qe-error">{error}</p>}
    {history && !history.versions.length && <p>No history exists for this file.</p>}
    <div className="qe-history-list">{history?.versions.map(item => <div key={item.id} className={item.id === version?.id ? 'is-active' : ''}>
      <span><time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleString()}</time><small>{item.path}</small></span>
      <button className="button" disabled={busy} onClick={() => void show(item, 'preview')}>Preview</button>
      <button className="button" disabled={busy} onClick={() => void show(item, 'compare')}>Compare</button>
    </div>)}</div>
    {busy && <p role="status">Working locally…</p>}
    {version && comparison && <><p>{mode === 'compare' ? comparison.snapshot === comparison.current.content ? 'Snapshot and current disk content are identical.' : 'Snapshot differs from current disk content. Side-by-side comparison below.' : 'Preview only. The current file is unchanged.'}</p>
      <div className={`qe-history-content ${mode === 'compare' ? 'is-comparing' : ''}`}>
        <section><h3>Snapshot · {new Date(version.timestamp).toLocaleString()}</h3><pre tabIndex={0} aria-label="Snapshot content">{comparison.snapshot}</pre></section>
        {mode === 'compare' && <section><h3>Current local file · read on Compare</h3><pre tabIndex={0} aria-label="Current disk content">{comparison.current.content}</pre></section>}
      </div>
      <div className="dialog-actions"><button className="button" disabled={busy} onClick={() => void show(version, 'compare')}>Refresh comparison</button><button className="button button-danger" disabled={busy || dirty || comparison.current.readOnly || comparison.current.lineEnding === 'mixed' || comparison.snapshot === comparison.current.content} onClick={() => setConfirm(true)}>Restore snapshot…</button></div>
    </>}
  </div>{confirm && <ConfirmDialog title="Restore file snapshot?" description={`Replace ${path} with the selected snapshot? The current disk version will be preserved in local history first. If the disk has changed since preview, restoration will stop.`} confirmText="Restore snapshot" destructive onCancel={() => setConfirm(false)} onConfirm={() => void apply()} />}</div>, document.body);
}
