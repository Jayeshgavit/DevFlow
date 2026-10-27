import { useOperationError } from './use-operation-error';
import { OperationNotice } from './NotificationCenter';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { closeOperation } from './operation-error';
import { errorMessage } from './operation-error';
import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ConfirmDialog } from './components';
import type { Project } from './types';
import type { EditorSession } from './editor-session';

const QuickEditor = lazy(() => import('./QuickEditor'));
type Handoff = { owner: string; snapshot?: EditorSession };
export const floatingEditor = new URLSearchParams(window.location.search).get('window') === 'quick-editor';

// One native close listener per window. Rust owns destruction and process cleanup.
export function WindowCloseHandler() {
  const pending = useRef(false);
  const [error, setError] = useOperationError();
  const [confirmation, setConfirmation] = useState<{ answer: (approved: boolean) => void }>();
  useEffect(() => {
    let disposed = false;
    let cancelConfirmation: (() => void) | undefined;
    const stops: (() => void)[] = [];
    const label = getCurrentWindow().label;
    const close = async (event: string) => {
      const operation = closeOperation(label, event);
      if (!operation) return;
      const exitApp = operation === 'shutdown_app';
      if (pending.current) return;
      pending.current = true; setError('');
      try {
        const approved = await new Promise<boolean>(resolve => {
          const check = new CustomEvent('devflow-close-check', { cancelable: true, detail: resolve });
          if (window.dispatchEvent(check)) resolve(true);
        });
        if (!approved || disposed) return;
        let confirmed = false;
        if (exitApp && await invoke<number>('managed_service_count') > 0) {
          confirmed = await new Promise<boolean>(answer => { cancelConfirmation = () => answer(false); setConfirmation({ answer }); });
          cancelConfirmation = undefined;
          if (!confirmed || disposed) return;
        }
        window.dispatchEvent(new Event('devflow-close-approved'));
        await invoke(operation, exitApp ? { confirmed } : undefined);
      } catch (cause) { if (!disposed) setError(`Could not close: ${errorMessage(cause)}`); }
      finally {
        window.dispatchEvent(new Event('devflow-close-cancelled'));
        pending.current = false;
      }
    };
    void (async () => {
      for (const event of ['app-close-requested', 'editor-close']) {
        if (!closeOperation(label, event)) continue;
        const stop = await listen(event, () => { if (!disposed) void close(event); }, { target: { kind: 'WebviewWindow', label } });
        if (disposed) stop(); else stops.push(stop);
      }
    })().catch(cause => { if (!disposed) setError(`Close handler unavailable: ${errorMessage(cause)}`, true); });
    return () => { disposed = true; cancelConfirmation?.(); stops.forEach(stop => stop()); };
  }, []);
  return <><OperationNotice message={error} dismiss={() => setError('')} />{confirmation && <ConfirmDialog title="Exit DevFlow?" description="DevFlow-managed services are still running or starting. Stop them and exit?" confirmText="Stop services and exit" destructive onCancel={() => { confirmation.answer(false); setConfirmation(undefined); }} onConfirm={() => { confirmation.answer(true); setConfirmation(undefined); }} />}</>;
}

export function EditorWorkspace({ projects, selected, onDock, active }: { projects: Project[]; selected?: Project; onDock: () => void; active: boolean }) {
  const [detached, setDetached] = useState(false);
  const [initial, setInitial] = useState<EditorSession>();
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useOperationError(true);
  const [listening, setListening] = useState(false);
  const adopted = useRef(false);
  const dockCallback = useRef(onDock); dockCallback.current = onDock;
  const restore = async () => {
    const session = await invoke<Handoff>('editor_window_session');
    if (session.owner !== 'docking' || !session.snapshot) return;
    // Snapshot remains in Rust until this receiver acknowledges it.
    if (!adopted.current) { adopted.current = true; setInitial(session.snapshot); setGeneration(value => value + 1); }
    dockCallback.current();
    await invoke('editor_accept_dock');
    setDetached(false); setError('');
  };
  useEffect(() => {
    let disposed = false;
    const stops: (() => void)[] = [];
    const subscribe = async () => {
      for (const [event, callback] of [
        ['editor-docked', () => { void restore().catch(cause => setError(errorMessage(cause))); }],
        ['editor-closed', () => { setInitial(undefined); setGeneration(value => value + 1); setDetached(false); setError(''); }],
      ] as const) {
        const stop = await listen(event, () => { if (!disposed) callback(); }, { target: 'main' });
        if (disposed) stop(); else stops.push(stop);
      }
      if (!disposed) {
        setListening(true);
        const session = await invoke<Handoff>('editor_window_session');
        if (disposed) return;
        if (session.owner === 'docking') await restore();
        else if (session.owner) setDetached(true);
      }
    };
    void subscribe().catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; stops.forEach(stop => stop()); };
  }, []);
  return <>
    <OperationNotice message={error} dismiss={() => setError('')} />
    {error && <button className="button" onClick={() => void restore().catch(cause => setError(errorMessage(cause)))}>Retry docking</button>}
    {detached ? <section className="qe-empty"><strong>Quick Editor is in its own window.</strong><span>Use Dock to return all open files here. Closing that window asks before discarding unsaved edits.</span><button className="button" onClick={() => void invoke<Handoff>('editor_recover_opening').then(session => { setInitial(session.snapshot); setGeneration(value => value + 1); setDetached(false); setError(''); }).catch(cause => setError(errorMessage(cause)))}>Recover if window failed to open</button></section> :
      <Suspense fallback={<p role="status">Loading Quick Editor…</p>}><QuickEditor key={generation} active={active} projects={projects} selected={selected} initial={initial} onTransfer={async snapshot => { if (!listening) throw new Error('Editor window events are not ready. Try again shortly.'); adopted.current = false; await invoke('editor_float', { snapshot }); setInitial(undefined); setDetached(true); }} /></Suspense>}
  </>;
}

export function FloatingEditor() {
  const [data, setData] = useState<{ session: EditorSession; projects: Project[] }>();
  const [error, setError] = useOperationError(true);
  useEffect(() => {
    let disposed = false;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      let theme = 'system'; try { theme = localStorage.getItem('devflow-theme') || theme; } catch { /* Optional preference. */ }
      document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
    };
    apply(); media.addEventListener('change', apply); window.addEventListener('storage', apply);
    void Promise.all([invoke<Handoff>('editor_window_session'), invoke<Project[]>('load_projects')]).then(([handoff, projects]) => {
      if (!handoff.snapshot) throw new Error('No editor session to restore. Return to DevFlow and use Recover.');
      if (!disposed) setData({ session: handoff.snapshot, projects });
    }).catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; media.removeEventListener('change', apply); window.removeEventListener('storage', apply); };
  }, []);
  return <main className="qe-floating"><OperationNotice message={error} dismiss={() => setError('')} />{data && <Suspense fallback={<p role="status">Loading editor…</p>}><QuickEditor projects={data.projects} initial={data.session} floating onTransfer={async snapshot => {
    await invoke('editor_dock', { snapshot });
    // Keep this view frozen until the main window accepts and destroys it.
    await new Promise<void>(() => {});
  }} /></Suspense>}</main>;
}
