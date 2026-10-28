import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMenuDismissal } from './menu-dismissal';
export type MenuAction = { label: string; disabled?: boolean; run: () => void | Promise<void> };
export function EditorContextMenu({ x, y, actions, close }: { x: number; y: number; actions: MenuAction[]; close: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useMenuDismissal(true, close, [menu], previousFocus);
  useLayoutEffect(() => {
    const element = menu.current; if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(6, Math.min(x, innerWidth - rect.width - 6))}px`;
    element.style.top = `${Math.max(6, Math.min(y, innerHeight - rect.height - 6))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('resize', close); if (previous?.isConnected && (element.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true }); };
  }, [x, y]);
  return createPortal(<div ref={menu} className="qe-context-menu" role="menu" aria-label="Quick Editor actions" style={{ left: x, top: y }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
    event.preventDefault(); controls[next]?.focus();
  }}>{actions.map(action => <button key={action.label} role="menuitem" disabled={action.disabled} onClick={() => { close(); void action.run(); }}>{action.label}</button>)}</div>, document.body);
}

export function EditorNameDialog({ title, initial, busy, error, submit, close, destination = '' }: { destination?: string; title: string; initial: string; busy: boolean; error: string; submit: (name: string, createParents: boolean) => void; close: () => void }) {
  const [createParents, setCreateParents] = React.useState(false);
  const [name, setName] = React.useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLFormElement>(null);
  React.useEffect(() => { const previous = document.activeElement as HTMLElement; input.current?.focus(); input.current?.select(); return () => previous?.focus(); }, []);
  return createPortal(<div className="dialog-backdrop"><form ref={dialog} className="dialog" role="dialog" aria-modal="true" aria-labelledby="qe-name-title" onSubmit={event => { event.preventDefault(); submit(name, createParents); }} onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    if (event.key === 'Tab') { const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)')]; const index = controls.indexOf(document.activeElement as HTMLElement); if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); } else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); } }
  }}><h2 id="qe-name-title">{title}</h2><label>New name<input className="qe-name-input" ref={input} aria-invalid={!!error} value={name} disabled={busy} onChange={event => setName(event.target.value)} required maxLength={255} /></label><p style={{ overflowWrap: 'anywhere' }}>Destination: {destination ? `${destination}/` : ''}{name || '(new name)'}</p><label><input type="checkbox" checked={createParents} onChange={e => setCreateParents(e.target.checked)} />Create Missing Directories</label><p>Use a project-relative nested path with forward slashes. Existing files are never replaced. Open drafts are retained when renaming.</p>{error && <p role="alert">{error}</p>}<div className="dialog-actions"><button className="button" type="button" disabled={busy} onClick={close}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Working…' : 'Apply'}</button></div></form></div>, document.body);
}
