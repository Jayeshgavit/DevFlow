import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Bell, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { NotificationStore, type Incident, type NotificationPreferences } from './notifications';
import type { Project } from './types';
import { Card } from './components';
import './notifications.css';

export function OperationNotice({ message, dismiss, severity = 'error' }: { message: string; dismiss: () => void; severity?: Incident['severity'] }) {
  if (!message) return null;
  return createPortal(<div className="notification-toast-region operation-notice-region"><div className={`notification-toast incident-${severity}`} role={severity === 'error' ? 'alert' : 'status'}>
    <div className="operation-notice-content"><span>DevFlow · {severity}</span><strong>{message}</strong></div>
    <button className="icon-button" aria-label="Dismiss notification" onClick={dismiss}><X size={16} /></button>
  </div></div>, document.body);
}

export const NotificationCenter = memo(function NotificationCenter({ store, projects, onOpen }: { store: NotificationStore; projects: Project[]; onOpen: (incident: Incident) => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<Incident | null>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const openIncident = useRef(onOpen);
  openIncident.current = onOpen;
  const unread = snapshot.history.filter(item => !item.read).length;
  useEffect(() => { store.onToast = setToast; return () => { store.onToast = undefined; }; }, [store]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>('notification-open', event => {
      if (disposed) return;
      const incident = store.getSnapshot().history.find(item => item.id === event.payload);
      if (!incident) return;
      restoreFocus.current = false;
      store.markRead(incident.id); setOpen(false); setToast(null); openIncident.current(incident);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {
      if (!disposed) store.record({ reason: 'application', message: 'Desktop notification navigation is unavailable. Open the notification center to review incidents.' });
    });
    return () => { disposed = true; unlisten?.(); };
  }, [store]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 6500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!open) return;
    restoreFocus.current = true;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      if (event.key === 'Tab') {
        const controls = panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (restoreFocus.current) previous?.focus(); };
  }, [open]);
  const navigate = (incident: Incident) => { restoreFocus.current = false; store.markRead(incident.id); setOpen(false); setToast(null); onOpen(incident); };
  return <>
    <button ref={bell} className="notification-bell icon-button" aria-label={`Notifications, ${unread} unread`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}><Bell size={18} />{unread > 0 && <span className="notification-count">{unread > 99 ? '99+' : unread}</span>}</button>
    {open && createPortal(<div className="notification-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}><div ref={panel} className="notification-center" role="dialog" aria-modal="true" aria-labelledby="notification-title">
      <header><h2 id="notification-title">Notifications</h2><button className="icon-button" aria-label="Close notifications" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className="notification-actions"><button onClick={() => store.markRead()} disabled={!unread}>Mark all read</button><button onClick={store.clearRead} disabled={!snapshot.history.some(item => item.read)}>Clear read</button></div>
      {snapshot.storageError && <p role="status">{snapshot.storageError}</p>}{snapshot.desktopError && <p role="status">{snapshot.desktopError}</p>}
      <div className="notification-history">{snapshot.history.length ? <ol>{snapshot.history.map(item => {
        const project = projects.find(project => project.id === item.projectId);
        const service = project?.services.find(service => service.id === item.serviceId);
        return <li key={item.id} className={`incident incident-${item.severity}${item.read ? '' : ' is-unread'}`}><button className="incident-open" onClick={() => navigate(item)}>
          <span className="incident-meta">{item.severity} · {item.reason.replace(/-/g, ' ')}{item.resolved ? ' · resolved' : ''}{!item.read ? ' · unread' : ''}</span>
          <strong>{item.message}</strong><span>{project?.name || (item.projectId ? 'Removed project' : 'DevFlow')}{service ? ` / ${service.name}` : ''}</span>
          <span><time dateTime={new Date(item.updatedAt).toISOString()} title={`First seen: ${new Date(item.createdAt).toLocaleString()}`}>{new Date(item.updatedAt).toLocaleString()}</time>{item.occurrences > 1 ? ` · ${item.occurrences} occurrences` : ''} · Open logs</span>
        </button>{!item.read && <button className="incident-read" onClick={() => store.markRead(item.id)}>Mark read</button>}</li>;
      })}</ol> : <p>No notifications. Service incidents will appear here.</p>}</div>
      <footer>Up to 300 events · 30 days · local to this device</footer>
    </div></div>, document.body)}
    <div className="notification-toast-region" role="status" aria-live="polite" aria-atomic="true">{toast && !snapshot.preferences.quiet && <div className={`notification-toast incident-${toast.severity}`}><button onClick={() => navigate(toast)}><span>DevFlow · {toast.severity}</span><strong>{toast.message}</strong><small>Open related logs</small></button><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}</div>
  </>;
});

export function NotificationSettings({ store }: { store: NotificationStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const options: [keyof NotificationPreferences, string, string][] = [
    ['desktop', 'Desktop alerts', 'Important incidents through Windows while DevFlow is open. Message details stay in the app.'],
    ['recovery', 'Recovery alerts', 'Show an in-app toast when a degraded endpoint recovers.'],
    ['routine', 'Routine activity', 'Count manual starts and stops as unread. They never interrupt you.'],
    ['quiet', 'Quiet mode', 'Suppress all toasts and desktop alerts. History and unread counts continue.'],
  ];
  return <Card className="settings-card"><div className="settings-heading"><Bell size={21} /><div><h2>Notifications</h2><p>Incidents are always recorded. No background service is added.</p></div></div>{options.map(([key, label, description]) => <div className="setting-row" key={key}><div><strong>{label}</strong><span>{description}</span></div><label className="switch"><input type="checkbox" checked={snapshot.preferences[key]} onChange={event => store.preferences({ [key]: event.target.checked })} /><span className="switch-track" /><span className="sr-only">{label}</span></label></div>)}{snapshot.storageError && <p role="status">{snapshot.storageError}</p>}{snapshot.desktopError && <p role="status">{snapshot.desktopError}</p>}</Card>;
}
