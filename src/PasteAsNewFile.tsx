import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from './types';
import { editorApi, extension, type NewFileInput, type NewFileOutcome } from './editor-api';
import { byteSize, type ClipboardBlock } from './smart-replace';
import { destination, type NewFileChoice } from './paste-new-file';
import { errorMessage } from './operation-error';
import AiCode from './AiCode';
import './paste-new-file.css';

export default function PasteAsNewFile({ project, blocks, folder, lease, create, open, close }: {
  project: Project; blocks: ClipboardBlock[]; folder: string; lease: number;
  create: (files: NewFileInput[], parents: boolean) => Promise<NewFileOutcome>;
  open: (path: string) => Promise<void>; close: () => void;
}) {
  const [choices, setChoices] = useState<NewFileChoice[]>(() => blocks.map(block => ({ selected: blocks.length === 1 || !!block.path, name: block.path || '', folder, resolution: '' })));
  const [index, setIndex] = useState(0), [parents, setParents] = useState(false);
  const [review, setReview] = useState<NewFileOutcome>(), [result, setResult] = useState<NewFileOutcome>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false);
  const [children, setChildren] = useState<string[]>([]), [browseError, setBrowseError] = useState('');
  const cancel = useRef<HTMLButtonElement>(null), operation = useRef(false);
  const choice = choices[index], block = blocks[index];
  const update = (patch: Partial<NewFileChoice>) => { setReview(undefined); setResult(undefined); setChoices(current => current.map((item, i) => i === index ? { ...item, ...patch } : item)); };
  const selected = choices.flatMap((item, i) => item.selected && !item.done ? [i] : []);
  let files: NewFileInput[] = [], pathError = '';
  try { files = selected.map(i => ({ path: destination(blocks[i], choices[i]), content: blocks[i].code })); } catch (cause) { pathError = errorMessage(cause); }
  const signature = JSON.stringify(files);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    setChildren([]); setBrowseError('');
    void editorApi.list(project, choice.folder.replace(/\\/g, '/')).then(entries => { if (!disposed) setChildren(entries.filter(entry => entry.directory && !entry.blocked).map(entry => entry.path)); }).catch(cause => { if (!disposed) setBrowseError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, [project.id, project.root, choice.folder]);
  useEffect(() => {
    let disposed = false; setReview(undefined); setError('');
    if (pathError || !files.length) { setChecking(false); return; }
    setChecking(true);
    const timer = setTimeout(() => {
      void editorApi.createFiles(project, files, lease, true, false).then(value => { if (!disposed) setReview(value); }).catch(cause => { if (!disposed) setError(errorMessage(cause)); }).finally(() => { if (!disposed) setChecking(false); });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [signature, pathError, project.id, project.root, lease]);
  const missing = [...new Set(review?.items.flatMap(item => item.missing) || [])];
  const ready = !!review && !checking && !pathError && !review.items.some(item => item.error) && (!missing.length || parents) && files.length > 0;
  let final = '';
  try { final = destination(block, choice); } catch { /* Display the selected path resolution controls below. */ }
  const currentReview = review?.items.find(item => item.path === final);
  return createPortal(<div className="dialog-backdrop"><div className="dialog qe-paste" role="dialog" aria-modal="true" aria-labelledby="qe-paste-title" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
      const i = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && i <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && i === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
  }}><h2 id="qe-paste-title">Paste as New File</h2><p>{project.name} · Review destinations and code before creating files.</p>
    <div className="qe-paste-layout"><nav aria-label="Detected files">{blocks.map((item, i) => <div key={i} className={index === i ? 'is-active' : ''}><input aria-label={`Select block ${i + 1}`} type="checkbox" disabled={busy || choices[i].done} checked={choices[i].selected} onChange={e => { setReview(undefined); setChoices(current => current.map((value, j) => j === i ? { ...value, selected: e.target.checked } : value)); }} /><button disabled={busy} aria-current={index === i ? 'true' : undefined} onClick={() => setIndex(i)}>{choices[i].done ? 'Created · ' : ''}{item.path || `Unnamed block ${i + 1}`}</button></div>)}</nav>
    <section aria-label="Destination and code preview"><fieldset disabled={busy || choice.done}>
      <label>Destination folder (project-relative)<input value={choice.folder} onChange={e => update({ folder: e.target.value, resolution: '' })} placeholder="Project root" /></label>
      <div className="qe-paste-browse"><button className="button" disabled={!choice.folder} onClick={() => update({ folder: choice.folder.replace(/\\/g, '/').split('/').slice(0, -1).join('/'), resolution: '' })}>Parent folder</button><select aria-label="Browse project folders" value="" onChange={e => update({ folder: e.target.value, resolution: '' })}><option value="">Choose a child folder…</option>{children.map(path => <option key={path}>{path}</option>)}</select><button className="button" onClick={() => update({ folder: '', resolution: '' })}>Project root</button></div>
      {browseError && <small>Folder unavailable or not yet created: {browseError}</small>}
      <label>Proposed filename / path<input value={choice.name} placeholder="Enter a project-relative filename" onChange={e => update({ name: e.target.value, resolution: '' })} /></label>
      {block.path && <><p>Clipboard: <code>{block.path}</code> · Chosen folder: <code>{choice.folder || '(project root)'}</code></p>{choice.folder && <label>Resolve destination<select value={choice.resolution} onChange={e => update({ resolution: e.target.value as NewFileChoice['resolution'] })}><option value="">Choose if paths differ…</option><option value="clipboard">Use proposed path relative to project root</option><option value="folder">Use filename in chosen folder</option></select></label>}</>}
      <p>Final destination: <strong>{final || 'Choose a valid destination'}</strong><br />{block.language || extension(choice.name) || 'Text'} · approximately {byteSize(block.code).toLocaleString()} bytes</p>
    </fieldset>
    {currentReview?.error && <p role="alert">{currentReview.error}</p>}
    {currentReview?.existing && <button className="button" disabled={busy} onClick={() => void open(final).then(close).catch(cause => setError(errorMessage(cause)))}>Open existing file · use Edit → Smart Replace</button>}
    <pre className="qe-paste-code" tabIndex={0}><AiCode className={`language-${block.language || extension(choice.name)}`}>{block.code}</AiCode></pre></section></div>
    <label><input type="checkbox" disabled={busy} checked={parents} onChange={e => setParents(e.target.checked)} />Create missing directories</label>
    <p>{files.length} files · {missing.length} missing folders{missing.length > 0 && `: ${missing.join(', ')}`}</p>
    {review?.items.filter(item => item.error).map(item => <p role="alert" key={item.path}>{item.path}: {item.error}</p>)}
    {(pathError || error) && <p role="alert">{pathError || error}</p>}
    {result && <div role="status"><p>Created {result.items.filter(item => item.created).length} files and {result.directories.length} folders. Existing files were preserved.</p>{result.directories.map(path => <p key={path}>Folder created: {path}</p>)}{result.items.map(item => <p key={item.path}>{item.path}: {item.error || (item.created ? 'Created and opened' : 'Not created')}</p>)}</div>}
    <div className="dialog-actions"><button ref={cancel} className="button" disabled={busy} onClick={close}>{result ? 'Close' : 'Cancel'}</button><button className="button button-primary" disabled={busy || !ready} onClick={async () => {
      if (!ready || operation.current) return;
      operation.current = true; setBusy(true); setError('');
      try {
        const value = await create(files, parents); setResult(value); setReview(undefined);
        const created = new Set(value.items.filter(item => item.created).map(item => item.path));
        setChoices(current => current.map((item, i) => { let path = ''; try { path = destination(blocks[i], item); } catch { /* Unselected entry. */ } return created.has(path) ? { ...item, done: true, selected: false } : item; }));
      } catch (cause) { setError(errorMessage(cause)); }
      finally { operation.current = false; setBusy(false); }
    }}>{busy ? 'Creating…' : checking ? 'Validating…' : `Create ${files.length === 1 ? 'File' : `${files.length} Files`}`}</button></div>
  </div></div>, document.body);
}
