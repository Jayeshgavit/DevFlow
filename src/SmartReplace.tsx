import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from './types';
import type { EditorTab } from './editor-session';
import { normalizeText } from './editor-api';
import { byteSize, matchSections, relativeClipboardPath, replacementPreview, SMART_LIMIT, symbolName, type ClipboardBlock, type ReplaceRange } from './smart-replace';
import { errorMessage } from './operation-error';
import './smart-replace.css';

export type SmartTarget = { tab: EditorTab; disk: string };
export type SmartReview = { target: SmartTarget; range: ReplaceRange; insertion: string; result: string };
export default function SmartReplace({ project, blocks, currentPath, selection, openPaths, load, search, apply, close }: {
  project: Project; blocks: ClipboardBlock[]; currentPath: string; selection?: ReplaceRange; openPaths: string[];
  load: (path: string) => Promise<SmartTarget>; search: (name: string) => Promise<string[]>;
  apply: (review: SmartReview) => Promise<void>; close: () => void;
}) {
  const [blockIndex, setBlockIndex] = useState(0);
  const block = blocks[blockIndex];
  const [targetPath, setTargetPath] = useState(block.path || currentPath);
  const [target, setTarget] = useState<SmartTarget>();
  const [ranges, setRanges] = useState<ReplaceRange[]>([]);
  const [rangeIndex, setRangeIndex] = useState(-1);
  const [mode, setMode] = useState<'section' | 'selection' | 'file'>('section');
  const [draftConsent, setDraftConsent] = useState(false);
  const [fileConsent, setFileConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [paths, setPaths] = useState(openPaths);
  const request = useRef(0), operation = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; cancel.current?.focus(); return () => { request.current++; previous?.focus(); }; }, []);
  const inspect = async (path: string, code: string) => {
    const generation = ++request.current;
    setTarget(undefined); setRanges([]); setRangeIndex(-1); setReviewed(false); setDraftConsent(false); setFileConsent(false); setError(''); setBusy(true);
    try {
      const value = await load(relativeClipboardPath(path));
      const found = await matchSections(value.tab.text, normalizeText(code), path);
      if (request.current !== generation) return;
      setTarget(value); setRanges(found); setRangeIndex(found.length === 1 ? 0 : -1);
      setMode(found.length ? 'section' : selection && path === currentPath ? 'selection' : 'section');
    } catch (cause) { if (request.current === generation) setError(`${errorMessage(cause)} New files belong in A6 Paste as New File; Smart Replace only edits existing eligible files.`); }
    finally { if (request.current === generation) setBusy(false); }
  };
  useEffect(() => { const path = block.path || currentPath; setTargetPath(path); void inspect(path, block.code); }, [blockIndex]);
  const range = target ? mode === 'file' ? { from: 0, to: target.tab.text.length, label: 'Entire file' } : mode === 'selection' ? target.tab.path === currentPath ? selection : undefined : ranges[rangeIndex] : undefined;
  // Editor drafts use LF. The unchanged save pipeline reconstructs CRLF/BOM.
  // Section fences often add a delimiter newline; preserve the original boundary.
  const normalized = normalizeText(block.code);
  const insertion = mode === 'section' && range && target ? normalized.replace(/\n$/, target.tab.text.slice(range.from, range.to).endsWith('\n') ? '\n' : '') : normalized;
  const preview = range && target ? replacementPreview(target.tab.text, range, insertion) : undefined;
  const dirty = !!target && target.tab.text !== target.tab.baseline;
  const permitted = preview && preview.result !== target?.tab.text && byteSize(preview.result) <= SMART_LIMIT && (!dirty || draftConsent) && (mode !== 'file' || fileConsent);
  const invalidate = () => { setReviewed(false); setFileConsent(false); };
  return createPortal(<div className="dialog-backdrop"><div className="dialog qe-smart" role="dialog" aria-modal="true" aria-labelledby="qe-smart-title" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    if (event.key === 'Tab') {
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1]?.focus(); }
      else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0]?.focus(); }
    }
  }}><header><h2 id="qe-smart-title">Smart Replace — {target?.tab.path.split('/').pop() || 'Clipboard'}</h2></header>
    <p>{project.name} · Local clipboard review · No disk writes</p>
    <label>Clipboard source<select disabled={busy} value={blockIndex} onChange={e => { setTarget(undefined); invalidate(); setBlockIndex(Number(e.target.value)); }}>{blocks.map((item, index) => <option key={index} value={index}>Block {index + 1} · {item.path || symbolName(item.code) || 'Unnamed code'} · {item.language || 'no language hint'} · {item.code.split(/\r\n|\n|\r/).length} lines</option>)}</select></label>
    <details><summary>Inspect clipboard code</summary><pre tabIndex={0}>{block.code}</pre></details>
    <div className="qe-smart-target"><label>Target in {project.name}<input list="qe-smart-paths" value={targetPath} disabled={busy} onChange={e => { request.current++; setTargetPath(e.target.value); setTarget(undefined); invalidate(); }} /></label><datalist id="qe-smart-paths">{paths.map(path => <option key={path} value={path} />)}</datalist><button className="button" disabled={busy || !targetPath} onClick={() => void inspect(targetPath, block.code)}>Change Target</button>
      <button className="button" disabled={busy || !symbolName(block.code)} onClick={async () => {
        setBusy(true); setError('');
        try {
          const name = symbolName(block.code)!;
          const found = await search(name);
          const matching: string[] = [];
          for (const path of openPaths.slice(0, 20)) {
            try { const value = await load(path); if ((await matchSections(value.tab.text, normalizeText(block.code), path)).length) matching.push(path); } catch { /* Ineligible targets never enter the candidate list. */ }
          }
          setPaths([...new Set([...matching, ...found, ...openPaths])]);
          setError(`Bounded search: ${matching.length} open-file declaration matches, ${found.length} filename candidates. Choose an exact path; candidates are not applied automatically.`);
        } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
      }}>Find other targets</button></div>
    {paths.length > 0 && <label>Candidate / open file<select disabled={busy} value="" onChange={e => { setTargetPath(e.target.value); void inspect(e.target.value, block.code); }}><option value="">Choose a target…</option>{paths.map(path => <option key={path}>{path}</option>)}</select></label>}
    <label>Change Mode<select disabled={busy} value={mode} onChange={e => { setMode(e.target.value as typeof mode); invalidate(); }}><option value="section">Replace matched section</option><option value="selection" disabled={!selection || target?.tab.path !== currentPath}>Replace selection</option><option value="file">Replace entire file (explicit)</option></select></label>
    {mode === 'section' && <label>Matched section<select disabled={busy} value={rangeIndex} onChange={e => { setRangeIndex(Number(e.target.value)); invalidate(); }}><option value={-1}>Choose a confirmed range…</option>{ranges.map((range, index) => <option key={index} value={index}>{range.label} · line {target!.tab.text.slice(0, range.from).split('\n').length}</option>)}</select></label>}
    {mode === 'section' && !ranges.length && target && <p role="status">No well-supported named declaration match. Select a range in the editor and reopen Smart Replace, or explicitly choose entire file.</p>}
    {ranges.length > 1 && <p role="status">Ambiguous: multiple declarations match. Choose the intended range before review.</p>}
    {ranges.length > 0 && mode === 'section' && <p>Match evidence: same declaration name and parser-delimited range. Textual identity heuristic; no compiler-level or semantic guarantee.</p>}
    {mode === 'file' && <label className="qe-smart-warning"><input type="checkbox" checked={fileConsent} onChange={e => setFileConsent(e.target.checked)} />Replace ALL file content, including code absent from the clipboard.</label>}
    {dirty && <label className="qe-smart-warning"><input type="checkbox" checked={draftConsent} onChange={e => setDraftConsent(e.target.checked)} />Apply to the current unsaved draft. Preserve its other edits; do not reload disk.</label>}
    {/\r/.test(block.code) && <p>Clipboard line endings normalize to the editor’s LF draft. Save preserves the target’s {target?.tab.document.lineEnding || 'existing'} disk line endings and BOM.</p>}
    {preview && target && <><p>{target.tab.path} · Original lines {preview.first}–{preview.last} · −{preview.removed} / +{preview.added}</p>
      {preview.newlineChanged && <p className="qe-smart-warning">Final newline will be {preview.result.endsWith('\n') ? 'added' : 'removed'}.</p>}
      {range && (range.to - range.from) / Math.max(1, target.tab.text.length) > .5 && <p className="qe-smart-warning">Substantial replacement: more than half of the current file is affected.</p>}
      {byteSize(preview.result) > SMART_LIMIT && <p role="alert">Result exceeds the 256 KiB Smart Replace safety limit.</p>}
      <button className="button" disabled={busy} onClick={() => setReviewed(true)}>Review Diff</button>
      {reviewed && <><pre className="qe-smart-diff" tabIndex={0} aria-label="Exact replacement diff">{preview.lines.map((line, i) => <span key={i} className={`qe-smart-${line.kind}`}>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}{line.text.replace(/\n$/, '')}</span>)}</pre><details><summary>Complete resulting file (exact draft)</summary><pre tabIndex={0}>{preview.result}</pre></details></>}
    </>}
    <p>Apply changes only the editor draft. Ctrl+S uses the existing save flow, which checks disk conflicts and creates the pre-save snapshot. No snapshot is created by Apply.</p>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Checking local content…</p>}
    <div className="dialog-actions"><button ref={cancel} className="button" disabled={busy} onClick={close}>Cancel</button><button className="button button-primary" disabled={busy || !permitted || !reviewed} onClick={async () => {
      if (operation.current || !target || !range || !preview || !permitted || !reviewed) return;
      operation.current = true; setBusy(true); setError('');
      try { await apply({ target, range, insertion, result: preview.result }); close(); }
      catch (cause) { setError(errorMessage(cause)); setReviewed(false); setTarget(undefined); }
      finally { operation.current = false; setBusy(false); }
    }}>Apply to Draft</button></div>
  </div></div>, document.body);
}
