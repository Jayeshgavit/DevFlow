import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, foldable, indentOnInput, syntaxHighlighting, syntaxTree, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel, closeSearchPanel, gotoLine } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { extension, type CodeSlice } from './editor-api';

export type EditorHandle = {
  slice: (kind: 'selection' | 'lines' | 'section' | 'all') => CodeSlice;
  find: () => void; goToLine: () => void; undo: () => void; redo: () => void;
  jump: (line: number) => void;
  clipboard: (action: 'cut' | 'copy' | 'paste') => Promise<void>;
  selectAll: () => void;
};
type Props = { content: string; path: string; editing: boolean; line?: number; onChange: (text: string) => void; onSelection: (from: number, to: number, selected: boolean) => void; onSave: () => void; onContextMenu: (event: React.MouseEvent) => void };

async function language(path: string) {
  switch (extension(path)) {
    case 'js': case 'mjs': case 'cjs': case 'jsx': case 'ts': case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ typescript: /\.(ts|tsx)$/i.test(path), jsx: /\.(jsx|tsx)$/i.test(path) });
    }
    case 'py': return (await import('@codemirror/lang-python')).python();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'html': case 'htm': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'md': case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    default: return [];
  }
}

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: 'var(--qe-syntax-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--qe-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--qe-syntax-number)' },
  { tag: tags.comment, color: 'var(--qe-syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.variableName, tags.definition(tags.variableName)], color: 'var(--qe-syntax-variable)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--qe-syntax-function)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--qe-syntax-property)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--qe-syntax-punctuation)' },
  { tag: tags.invalid, color: 'var(--danger)', textDecoration: 'underline wavy' },
  { tag: [tags.typeName, tags.className, tags.tagName], color: 'var(--qe-syntax-type)' },
  { tag: [tags.heading, tags.strong], fontWeight: '600' },
  { tag: tags.link, color: 'var(--accent-strong)', textDecoration: 'underline' },
]);

export default forwardRef<EditorHandle, Props>(function EditorSurface(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView>();
  const callbacks = useRef(props); callbacks.current = props;
  const editable = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const languages = new Compartment();
    const view = new EditorView({ parent: host.current, state: EditorState.create({
      doc: props.content,
      extensions: [
        lineNumbers(), foldGutter(), drawSelection(), highlightActiveLine(), highlightActiveLineGutter(),
        history(), indentOnInput(), bracketMatching(), search(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), syntaxHighlighting(highlighting),
        editable.current.of([EditorState.readOnly.of(!props.editing)]), languages.of([]),
        EditorView.contentAttributes.of({ 'aria-label': 'File contents', spellcheck: 'false' }),
        keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave(); return true; } }, { key: 'Mod-h', run: openSearchPanel }, ...searchKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const range = update.state.selection.main;
            callbacks.current.onSelection(update.state.doc.lineAt(range.from).number, update.state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number, !range.empty);
          }
        }),
      ],
    }) });
    editor.current = view;
    language(props.path).then(value => { if (!disposed) view.dispatch({ effects: languages.reconfigure(value) }); }).catch(() => { /* Plain text remains usable if language loading fails. */ });
    return () => { disposed = true; editor.current = undefined; view.destroy(); };
  }, []);
  useEffect(() => {
    if (!editor.current) return;
    closeSearchPanel(editor.current);
    editor.current.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(!props.editing)) });
  }, [props.editing]);

  useEffect(() => {
    const view = editor.current;
    if (!view || !props.line) return;
    const at = view.state.doc.line(Math.min(Math.max(1, props.line), view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'start' }) }); view.focus();
  }, [props.line]);
  useImperativeHandle(ref, () => ({
    selectAll: () => { if (editor.current) { selectAll(editor.current); editor.current.focus(); } },
    clipboard: async action => {
      const view = editor.current; if (!view) return;
      const state = view.state; const range = state.selection.main;
      if (action !== 'paste' && range.empty) return;
      if (action === 'copy' || action === 'cut') await navigator.clipboard.writeText(state.sliceDoc(range.from, range.to));
      if (action === 'copy') return;
      const value = action === 'paste' ? await navigator.clipboard.readText() : '';
      if (editor.current !== view || !callbacks.current.editing || view.state.doc !== state.doc || !view.state.selection.eq(state.selection)) throw new Error('Editor changed while accessing the clipboard. Try again.');
      view.dispatch({ ...view.state.replaceSelection(value), userEvent: action === 'paste' ? 'input.paste' : 'delete.cut', scrollIntoView: true });
      view.focus();
    },
    find: () => { if (editor.current) openSearchPanel(editor.current); },
    goToLine: () => { if (editor.current) gotoLine(editor.current); },
    undo: () => { if (editor.current && callbacks.current.editing) undo(editor.current); },
    redo: () => { if (editor.current && callbacks.current.editing) redo(editor.current); },
    jump: line => {
      const view = editor.current; if (!view) return;
      const at = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines)).from;
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'start' }) }); view.focus();
    },
    slice: kind => {
      const view = editor.current; if (!view) return { text: '', from: 1, to: 1 };
      const { state } = view; const range = state.selection.main;
      let from = range.from, to = range.to;
      if (kind === 'all') { from = 0; to = state.doc.length; }
      if (kind === 'lines' || (kind === 'selection' && range.empty)) {
        from = state.doc.lineAt(from).from;
        to = state.doc.lineAt(range.empty ? to : Math.max(from, to - 1)).to;
      }
      if (kind === 'section') {
        let node = syntaxTree(state).resolveInner(range.head, -1);
        let bounds: { from: number; to: number } | null = null;
        while (node.parent) {
          const line = state.doc.lineAt(node.from);
          const folded = foldable(state, line.from, line.to);
          if (folded && folded.to >= range.head && line.from <= range.head) { bounds = { from: line.from, to: state.doc.lineAt(folded.to).to }; break; }
          node = node.parent;
        }
        // Plain text and unsupported syntax use the surrounding nonblank block.
        let first = state.doc.lineAt(range.head).number, last = first;
        if (!bounds) {
          while (first > 1 && state.doc.line(first - 1).text.trim()) first--;
          while (last < state.doc.lines && state.doc.line(last + 1).text.trim()) last++;
        }
        from = bounds?.from ?? state.doc.line(first).from; to = bounds?.to ?? state.doc.line(last).to;
      }
      return { text: state.sliceDoc(from, to), from: state.doc.lineAt(from).number, to: state.doc.lineAt(to > from ? to - 1 : to).number };
    },
  }), []);
  return <div ref={host} className="qe-code" onContextMenu={props.onContextMenu} />;
});
