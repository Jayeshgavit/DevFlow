import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { tags } from '@lezer/highlight';

export type ApiTextHandle = { find: () => void; selection: () => string };
const colors = HighlightStyle.define([
  { tag: tags.string, color: 'var(--success)' }, { tag: [tags.number, tags.bool, tags.null], color: 'var(--accent-strong)' },
  { tag: tags.propertyName, color: 'var(--text)' }, { tag: tags.invalid, color: 'var(--danger)' },
]);
/** Isolated CodeMirror document: responses are always inert, virtualized text. */
export default forwardRef<ApiTextHandle, { value: string; onChange?: (value: string) => void; onLimit?: () => void; jsonMode?: boolean; label: string }>(function ApiTextEditor({ value, onChange, onLimit, jsonMode, label }, ref) {
  const host = useRef<HTMLDivElement>(null); const view = useRef<EditorView>();
  const change = useRef(onChange); change.current = onChange;
  const limit = useRef(onLimit); limit.current = onLimit;
  const language = useRef(new Compartment());
  useImperativeHandle(ref, () => ({ find: () => { if (view.current) { openSearchPanel(view.current); view.current.focus(); } }, selection: () => { const state = view.current?.state; return state ? state.sliceDoc(state.selection.main.from, state.selection.main.to) : ''; } }), []);
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      lineNumbers(), EditorView.lineWrapping, search(), ...(onChange ? [history({ minDepth: 20 })] : []), keymap.of([...searchKeymap, ...defaultKeymap, ...(onChange ? historyKeymap : [])]),
      EditorState.readOnly.of(!onChange), EditorView.editable.of(!!onChange), EditorView.contentAttributes.of({ 'aria-label': label }),
      EditorState.transactionFilter.of(transaction => {
        if (onChange && transaction.docChanged && new TextEncoder().encode(transaction.newDoc.toString()).length > 128 * 1024) { limit.current?.(); return []; }
        return transaction;
      }),
      language.current.of(jsonMode && value.length <= 128 * 1024 ? [json(), syntaxHighlighting(colors)] : []),
      EditorView.updateListener.of(update => { if (update.docChanged && change.current) change.current(update.state.doc.toString()); }),
      EditorView.theme({ '&': { height: '100%', backgroundColor: 'var(--surface-input)', color: 'var(--text)' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12px' }, '.cm-gutters': { backgroundColor: 'var(--surface-soft)', color: 'var(--text-faint)', borderColor: 'var(--border-soft)' }, '.cm-content': { caretColor: 'var(--text)' }, '.cm-cursor': { borderLeftColor: 'var(--text)' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--sidebar-active)' }, '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--text)' } }),
    ] }) });
    view.current = editor;
    return () => { editor.destroy(); view.current = undefined; };
    // This component's editable/read-only role is fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const editor = view.current; if (!editor) return;
    if (editor.state.doc.toString() !== value) {
      // External replacement must not call onChange or add response text to undo history.
      const listener = change.current; change.current = undefined;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
      change.current = listener;
    }
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: language.current.reconfigure(jsonMode && value.length <= 128 * 1024 ? [json(), syntaxHighlighting(colors)] : []) }); }, [jsonMode, value.length > 128 * 1024]);
  return <div className="api-code" ref={host} />;
});
