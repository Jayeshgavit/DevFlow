import { useOperationError } from './use-operation-error';
import { OperationNotice } from './NotificationCenter';
import { errorMessage } from './operation-error';
import React, { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Braces, Check, ChevronDown, ChevronRight, ChevronsUpDown, Clipboard, Code2, Copy, FileCode2, FileText, FolderClosed, FolderOpen, ListTree, Loader2, PanelLeftClose, PanelLeftOpen, Pencil, RefreshCw, RotateCcw, RotateCw, Save, Search, ExternalLink, PanelBottom, PanelBottomClose, Sparkles, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, ConfirmDialog } from './components';
import type { Project } from './types';
import { aiContext, diskText, editorApi, extension, isMarkdown, normalizeText, type FileEntry } from './editor-api';
import type { EditorHandle } from './EditorSurface';
import { closeTab, renameTabs, renamedPath, sessionDirty, tabDirty, tabKey, type EditorSession, type EditorTab } from './editor-session';
import { EditorContextMenu, EditorNameDialog, type MenuAction } from './EditorContextMenu';
import { useMenuDismissal } from './menu-dismissal';
import EditorHistory from './EditorHistory';
import './quick-editor.css';
import { ProjectServiceAction, ProjectServiceErrors, ProjectServiceStatus } from './ProjectServiceControls';
import { LogsHeader, ProjectLogs, floatLogs } from './SharedLogs';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

const EditorSurface = lazy(() => import('./EditorSurface'));
type FolderState = { entries?: FileEntry[]; error?: string; loading?: boolean };
const initialWidth = () => { try { return Math.max(180, Math.min(400, Number(localStorage.getItem('devflow-editor-width')) || 260)); } catch { return 260; } };

function FileIcon({ name }: { name: string }) {
  return isMarkdown(name) ? <FileText size={15} className="qe-icon-markdown" /> : /\.(json|css)$/i.test(name) ? <Braces size={15} className="qe-icon-data" /> : <FileCode2 size={15} className="qe-icon-code" />;
}

function Preview({ text, copy }: { text: string; copy: (text: string, message: string) => void }) {
  return <article className="qe-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => /^(https?:\/\/|mailto:|#[^\s]*)/i.test(url) ? url : ''} components={{
    a: ({ href, children }) => href ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
    // No remote images: previewing a local README must not trigger tracking requests.
    img: ({ alt }) => <span className="qe-image-label">[Image: {alt || 'image'}]</span>,
    pre: ({ children }) => <div className="qe-fenced"><button aria-label="Copy code block" title="Copy code block" onClick={event => { const code = event.currentTarget.parentElement?.querySelector('code'); if (code) copy(code.textContent || '', 'Code block copied'); }}><Copy size={14} /></button><pre>{children}</pre></div>,
  }}>{text}</Markdown></article>;
}

export default function QuickEditor({ projects, selected, initial, floating = false, onTransfer, active: visible = true }: { projects: Project[]; selected?: Project; initial?: EditorSession; floating?: boolean; onTransfer: (session: EditorSession) => Promise<void>; active?: boolean }) {
  type LogLocation = { projectId: string; path: string; line: number };
  const [pendingLocation, setPendingLocation] = useState<LogLocation>();
  const [logJump, setLogJump] = useState<LogLocation>();
  const [workspace, setWorkspace] = useState<Project | undefined>(initial ? initial.workspace : selected);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [logsHeight, setLogsHeight] = useState(330);
  const [pendingLogs, setPendingLogs] = useState<string[]>([]);
  const layout = useRef<HTMLDivElement>(null);
  const [lease, setLease] = useState<number>();
  useEffect(() => {
    if (lease === undefined) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const refresh = () => { void invoke<string[]>('logs_pending').then(ids => { if (!disposed) setPendingLogs(ids); }).catch(cause => { if (!disposed) setError(`Could not check pending logs: ${errorMessage(cause)}`, false); }); };
    void listen('logs-dock-requested', refresh, { target: getCurrentWindow().label }).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; refresh(); } }).catch(cause => { if (!disposed) setError(`Log docking notifications are unavailable: ${errorMessage(cause)}`); });
    return () => { disposed = true; stop?.(); };
  }, [lease]);
  useEffect(() => { if (workspace && pendingLogs.includes(workspace.id)) setLogsOpen(true); }, [workspace?.id, pendingLogs]);
  useEffect(() => {
    if (!visible || !logsOpen || !workspace || !pendingLogs.includes(workspace.id)) return;
    let disposed = false;
    void invoke('logs_accept_dock', { projectId: workspace.id }).then(() => { if (!disposed) { setPendingLogs(ids => ids.filter(id => id !== workspace.id)); setError(''); } }).catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, [visible, logsOpen, workspace?.id, pendingLogs]);
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const [expanded, setExpanded] = useState(new Set(['']));
  const [tabs, setTabs] = useState<EditorTab[]>(initial?.tabs || []);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const [path, setPath] = useState(initial?.active || '');
  const active = tabs.find(tab => tabKey(tab.path) === tabKey(path));
  const document = active?.document;
  const text = active?.text || '';
  const editing = active?.editing || false;
  const surfaceOpened = active?.surfaceOpened || false;
  const updateTab = (patch: Partial<EditorTab>) => setTabs(current => current.map(tab => tabKey(tab.path) === tabKey(path) ? { ...tab, ...patch } : tab));
  const setText = (text: string) => updateTab({ text });
  const setEditing = (editing: boolean) => updateTab({ editing });
  const setSurfaceOpened = (surfaceOpened: boolean) => updateTab({ surfaceOpened });
  const [loading, setLoading] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [error, setError] = useOperationError();
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FileEntry }>();
  const [naming, setNaming] = useState<{ entry: FileEntry; action: 'file' | 'folder' | 'rename' }>();
  const [nameError, setNameError] = useState('');
  const [working, setWorking] = useState(false);
  const workLock = useRef(false);
  const [copyWarnings, setCopyWarnings] = useState<string[]>([]);
  useEffect(() => { if (floating) return; let disposed = false; void editorApi.lease().then(value => { if (!disposed) setLease(value); }).catch(cause => { if (!disposed) setError(errorMessage(cause)); }); return () => { disposed = true; }; }, []);
  const backup = active?.backup || '';
  const [transferring, setTransferring] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeLock = useRef(false);
  const [selection, setSelection] = useState({ from: 1, to: 1, selected: false });
  const [width, setWidth] = useState(initial?.width ?? initialWidth);
  const [collapsed, setCollapsed] = useState(initial?.collapsed || false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const copyMenu = useRef<HTMLDetailsElement>(null);
  const copyTrigger = useRef<HTMLElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const outlineSearch = useRef<HTMLLabelElement>(null);
  useMenuDismissal(copyOpen, () => setCopyOpen(false), [copyMenu], copyTrigger);
  useMenuDismissal(outlineOpen, () => setOutlineOpen(false), [outline, outlineTrigger, outlineSearch], outlineTrigger);
  const [previewSearch, setPreviewSearch] = useState('');
  const [confirm, setConfirm] = useState<{ description: string; action: () => void; cancel?: () => void }>();
  const editor = useRef<EditorHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const epoch = useRef(0);
  const fileRequest = useRef(0);
  const saveLock = useRef(false);
  const allowClose = useRef(false);
  const dirty = !!active && tabDirty(active);
  const unsaved = useRef(false); unsaved.current = sessionDirty(tabs) || saving || working;
  const markdown = isMarkdown(path) && !(logJump && logJump.projectId === workspace?.id && tabKey(logJump.path) === tabKey(path));
  const writable = document && !document.readOnly && document.lineEnding !== 'mixed';

  const guard = useCallback((action: () => void) => {
    if (saveLock.current || workLock.current) return;
    if (unsaved.current) setConfirm({ description: 'Open files have unsaved edits. Discard them and continue? Copy your changes first if you need to keep them.', action });
    else action();
  }, []);

  const listFolder = useCallback(async (folder: string, project: Project, generation: number) => {
    setFolders(current => ({ ...current, [folder]: { ...current[folder], loading: true, error: undefined } }));
    try {
      const entries = await editorApi.list(project, folder);
      if (epoch.current === generation) setFolders(current => ({ ...current, [folder]: { entries } }));
    } catch (cause) { if (epoch.current === generation) setFolders(current => ({ ...current, [folder]: { error: errorMessage(cause) } })); }
  }, []);

  const switchProject = useCallback((project?: Project) => {
    epoch.current++; fileRequest.current++;
    setWorkspace(project); setFolders({}); setExpanded(new Set([''])); setPath(''); setTabs([]); setError(''); setNotice(''); setLoading(false);
    if (project) void listFolder('', project, epoch.current);
  }, [listFolder]);

  useEffect(() => { if (workspace) void listFolder('', workspace, epoch.current); }, []);
  useEffect(() => {
    if (workspace && !projects.some(p => p.id === workspace.id)) {
      // Keep an orphaned draft available to copy after a project is removed.
      if (unsaved.current) setError('This project was removed. Copy your unsaved edits before choosing another project.', true);
      else switchProject(undefined);
    }
  }, [projects, workspace, switchProject]);
  useEffect(() => { try { localStorage.setItem('devflow-editor-width', String(width)); } catch { /* Optional preference. */ } }, [width]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (unsaved.current && !allowClose.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    const closeCheck = (event: Event) => {
      const request = event as CustomEvent<(approved: boolean) => void>;
      event.preventDefault();
      if (saveLock.current || workLock.current || transferLock.current) {
        setError('Wait for the current editor operation to finish before closing.');
        request.detail(false);
      } else if (unsaved.current) {
        setConfirm({ description: 'Close and discard all open files’ unsaved edits? Copy your changes first if you need to keep them.', action: () => request.detail(true), cancel: () => request.detail(false) });
      } else request.detail(true);
    };
    const approveClose = () => { allowClose.current = true; closeLock.current = true; setClosing(true); setMenu(undefined); setNaming(undefined); };
    const cancelClose = () => { allowClose.current = false; closeLock.current = false; setClosing(false); };
    window.addEventListener('devflow-close-check', closeCheck);
    window.addEventListener('devflow-close-approved', approveClose);
    window.addEventListener('devflow-close-cancelled', cancelClose);
    let disposed = false;
    (async () => {
      if (disposed) return;
      if (floating) {
        const { invoke } = await import('@tauri-apps/api/core');
        if (disposed) return;
        await invoke('editor_window_ready');
        const token = await editorApi.lease();
        if (!disposed) setLease(token);
        return;
      }
    })().catch(cause => { if (!disposed) setError(`Native close protection could not be enabled: ${errorMessage(cause)}`, true); });
    return () => {
      disposed = true; window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('devflow-close-check', closeCheck);
      window.removeEventListener('devflow-close-approved', approveClose);
      window.removeEventListener('devflow-close-cancelled', cancelClose);
    };
  }, []);

  const transferLock = useRef(false);
  const transfer = async () => {
    if (closeLock.current || saveLock.current || workLock.current || loading || transferLock.current || naming) return;
    transferLock.current = true; setTransferring(true); setError('');
    try { await onTransfer({ workspace, tabs, active: path, width, collapsed }); }
    catch (cause) {
      setError(errorMessage(cause), true);
      // A failed window creation rotates the backend lease while retaining this draft.
      try { setLease(await editorApi.lease()); } catch { setLease(undefined); }
    }
    finally { transferLock.current = false; setTransferring(false); }
  };
  const selectTab = (next: string) => {
    fileRequest.current++; setLoading(false); setPath(next); setLoadedVersion(value => value + 1);
    setSelection({ from: 1, to: 1, selected: false }); setNotice(''); setError(''); setPreviewSearch(''); setOutlineOpen(false);
  };
  const openFile = async (next: string, reload = false) => {
    if (!workspace || saveLock.current || transferLock.current) return;
    const currentTabs = tabsRef.current;
    const existing = currentTabs.find(tab => tabKey(tab.path) === tabKey(next));
    if (existing && !reload) { selectTab(existing.path); return; }
    if (!reload && (currentTabs.length >= 20 || currentTabs.reduce((size, tab) => size + tab.text.length + tab.document.content.length, 0) >= 16 * 1024 * 1024)) { setError('Close some tabs before opening more files (20 tabs / 16 MiB text budget).'); return; }
    const request = ++fileRequest.current;
    setLoading(true); setError(''); setNotice('');
    try {
      const result = await editorApi.read(workspace, next);
      if (request !== fileRequest.current) return;
      const tab: EditorTab = { path: next, document: result, baseline: normalizeText(result.content), text: normalizeText(result.content), editing: false, surfaceOpened: !isMarkdown(next), backup: '' };
      setTabs(current => existing ? current.map(item => tabKey(item.path) === tabKey(next) ? tab : item) : [...current, tab]); setPath(next); setLoadedVersion(value => value + 1); setSelection({ from: 1, to: 1, selected: false }); setPreviewSearch('');
    } catch (cause) { if (request === fileRequest.current) setError(errorMessage(cause)); }
    finally { if (request === fileRequest.current) setLoading(false); }
  };

  useEffect(() => {
    let disposed = false; let stop: (() => void) | undefined;
    const refresh = () => { void invoke<LogLocation | null>('logs_take_location').then(location => { if (!disposed && location) setPendingLocation(location); }).catch(cause => { if (!disposed) setError(`Could not open log location: ${errorMessage(cause)}`); }); };
    void listen('logs-open-location', refresh, { target: getCurrentWindow().label }).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; refresh(); } }).catch(cause => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; stop?.(); };
  }, []);
  useEffect(() => {
    if (!pendingLocation || saving || loading || transferring || working) return;
    const target = projects.find(project => project.id === pendingLocation.projectId);
    if (!target) { setPendingLocation(undefined); setError('The project for this log location is no longer available.'); return; }
    if (workspace?.id !== target.id) {
      const change = () => switchProject(target);
      if (unsaved.current) setConfirm({ description: 'Open a log location in another project? Unsaved edits must be discarded to switch projects.', action: change, cancel: () => setPendingLocation(undefined) });
      else change();
      return;
    }
    const location = pendingLocation;
    setPendingLocation(undefined);
    void openFile(location.path).then(() => {
      setLogJump(location);
      setTabs(current => current.map(tab => tabKey(tab.path) === tabKey(location.path) ? { ...tab, surfaceOpened: true } : tab));
    });
  }, [pendingLocation, workspace?.id, saving, loading, transferring, working]);

  const save = async () => {
    if (historyOpen || closeLock.current || !workspace || !document || !editing || !dirty || !writable || saveLock.current || workLock.current || loading || transferLock.current || lease === undefined || naming) return;
    saveLock.current = true; setSaving(true); setError(''); setNotice('');
    const content = diskText(text, document);
    try {
      const recovery = await editorApi.save(workspace, path, document.content, content, lease);
      updateTab({ document: { ...document, content }, baseline: normalizeText(content), backup: recovery }); setNotice(recovery ? 'Saved · previous version in local history' : 'Saved · history excluded for this file');
    } catch (cause) { setError(`Could not save file: ${errorMessage(cause)}`, true); }
    finally { saveLock.current = false; setSaving(false); }
  };
  const latestSave = useRef(save); latestSave.current = save;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && container.current && !container.current.closest('[hidden]')) {
        event.preventDefault(); void latestSave.current();
      }
    };
    window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const copy = async (value: string, message: string) => {
    try { setNotice(''); await navigator.clipboard.writeText(value); setError(''); setNotice(message); } catch (cause) { setError(`Clipboard unavailable: ${errorMessage(cause)}`, false); }
  };
  const copySlice = (kind: 'selection' | 'lines' | 'section' | 'all', ai = false) => {
    const slice = markdown && !editing ? { text, from: 1, to: text.split('\n').length } : editor.current?.slice(kind);
    if (slice) void runAction(async () => { if (ai && workspace) await editorApi.export(workspace, path, 'file', text); await copy(ai ? aiContext(path, slice) : slice.text, ai ? 'AI context copied' : 'Code copied'); });
  };

  const runAction = async (action: () => Promise<void>) => {
    if (closeLock.current || workLock.current || saveLock.current || transferLock.current || loading) return;
    workLock.current = true; setWorking(true); setError('');
    try { await action(); } catch (cause) { setError(errorMessage(cause)); }
    finally { workLock.current = false; setWorking(false); }
  };
  const showMenu = (event: React.MouseEvent, entry?: FileEntry) => {
    event.preventDefault(); event.stopPropagation();
    if (saveLock.current || workLock.current || transferLock.current || loading) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX || rect.left + 16, y: event.clientY || rect.top + 16, entry });
  };
  const rootEntry: FileEntry = { name: workspace?.name || '', path: '', directory: true, blocked: false };
  const fileText = async (entry: FileEntry) => {
    const tab = tabsRef.current.find(tab => tabKey(tab.path) === tabKey(entry.path));
    if (tab) return diskText(tab.text, tab.document);
    if (!workspace) throw new Error('Choose a project first.');
    return (await editorApi.read(workspace, entry.path)).content;
  };
  const exportEntry = async (entry: FileEntry, mode: 'file' | 'folder' | 'tree') => {
    if (!workspace) return;
    const tab = mode === 'file' ? tabsRef.current.find(tab => tabKey(tab.path) === tabKey(entry.path)) : undefined;
    const result = await editorApi.export(workspace, entry.path, mode, tab ? diskText(tab.text, tab.document) : undefined);
    setCopyWarnings(result.warnings);
    await copy(result.text, `${mode === 'tree' ? 'Folder tree' : 'AI context'} copied · ${result.files} files${tab && tabDirty(tab) ? ' · includes draft' : ''}`);
  };
  const applyName = async (name: string) => {
    if (!workspace || !naming || lease === undefined || workLock.current || saveLock.current) return;
    const operation = naming;
    workLock.current = true; setWorking(true); setNameError('');
    try {
      const next = await editorApi.mutate(workspace, operation.entry.path, operation.action, name, lease);
      if (operation.action === 'rename') {
        setTabs(current => renameTabs(current, operation.entry.path, next));
        setPath(current => renamedPath(current, operation.entry.path, next));
        setLoadedVersion(value => value + 1);
      }
      setNaming(undefined); setFolders({}); setExpanded(new Set(['']));
      await listFolder('', workspace, ++epoch.current);
      setNotice(operation.action === 'rename' ? 'Renamed · open drafts retained' : 'Created');
    } catch (cause) { setNameError(errorMessage(cause)); }
    finally { workLock.current = false; setWorking(false); }
  };
  const menuActions = (): MenuAction[] => {
    if (menu?.entry) {
      const entry = menu.entry;
      const full = workspace ? `${workspace.root.replace(/[\\/]$/, '')}${entry.path ? `\\${entry.path.replace(/\//g, '\\')}` : ''}` : '';
      const guarded = (label: string, action: () => Promise<void>): MenuAction => ({ label, disabled: entry.blocked, run: () => runAction(action) });
      const name = entry.directory ? 'Folder' : 'File';
      return [
        ...(entry.directory ? ['file', 'folder'].map(action => ({ label: action === 'file' ? 'New File' : 'New Folder', disabled: lease === undefined || entry.blocked, run: () => { setNameError(''); setNaming({ entry, action: action as 'file' | 'folder' }); } })) : [{ label: 'Open', disabled: entry.blocked, run: () => openFile(entry.path) }]),
        { label: 'Rename', disabled: !entry.path || entry.blocked || lease === undefined, run: () => { setNameError(''); setNaming({ entry, action: 'rename' }); } },
        guarded(`Copy ${name} Name`, () => copy(entry.name, 'Name copied')),
        guarded('Copy Relative Path', () => copy(entry.path || '.', 'Relative path copied')),
        guarded('Copy Full Path', () => copy(full, 'Full path copied')),
        ...(entry.directory ? [guarded('Copy Folder Tree', () => exportEntry(entry, 'tree')), guarded('Copy Folder for AI', () => exportEntry(entry, 'folder'))] : [guarded('Copy Entire File Content', async () => { await copy(await fileText(entry), 'File content copied'); }), guarded('Copy File for AI', () => exportEntry(entry, 'file'))]),
        guarded('Reveal in Windows Explorer', async () => { if (workspace) await editorApi.reveal(workspace, entry.path, entry.directory); }),
      ];
    }
    return [
      ...(['cut', 'copy', 'paste'] as const).map(action => ({ label: action[0].toUpperCase() + action.slice(1), disabled: !document || (action === 'paste' ? !editing : !selection.selected) || (action === 'cut' && !editing), run: async () => { try { await editor.current?.clipboard(action); } catch (cause) { setError(`Clipboard unavailable: ${errorMessage(cause)}`, false); } } })),
      { label: 'Select All', disabled: !surfaceOpened || markdown && !editing, run: () => editor.current?.selectAll() },
      { label: 'Copy Selection for AI', disabled: !document || !selection.selected, run: () => copySlice('selection', true) },
      { label: 'Copy Entire File Content', disabled: !document, run: () => document ? copy(diskText(text, document), 'File content copied') : undefined },
      { label: 'Copy File Path', disabled: !path, run: () => copy(path, 'Relative path copied') },
    ];
  };

  const deferredText = useDeferredValue(text);
  const sections = useMemo(() => {
    // Best-effort outline, never presented as language-server analysis.
    const result: { line: number; label: string }[] = [];
    let inFence = false;
    deferredText.split('\n').forEach((line, index) => {
      if (markdown && /^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
      const match = markdown ? !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : /^(?:\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|def)\s+([\w$]+)|\s*(?:export\s+)?(?:const|let)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>)/.exec(line);
      if (match) result.push({ line: index + 1, label: markdown ? match[2] : match[1] || match[2] });
    });
    return result;
  }, [deferredText, markdown]);
  const jump = (line: number, index?: number) => {
    if (markdown && !editing) {
      const headings = preview.current?.querySelectorAll('h1,h2,h3,h4,h5,h6');
      if (index !== undefined) headings?.[index]?.scrollIntoView({ block: 'start' });
    } else editor.current?.jump(line);
    setOutlineOpen(false);
  };
  const renderFolder = (folder: string, depth: number): React.ReactNode => {
    const state = folders[folder];
    if (state?.loading) return <div className="qe-tree-message" role="status"><Loader2 size={13} className="qe-spin" />Loading folder…</div>;
    if (state?.error) return <div className="qe-tree-message qe-tree-error"><span>{state.error}</span><button onClick={() => workspace && void listFolder(folder, workspace, epoch.current)}>Retry</button></div>;
    return state?.entries?.length ? state.entries.map(entry => <React.Fragment key={entry.path}>
      <button className={`qe-tree-row ${path === entry.path ? 'is-selected' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} title={entry.blocked ? `${entry.path} · linked or unsupported entry blocked` : entry.path} aria-current={path === entry.path ? 'true' : undefined} aria-expanded={entry.directory ? expanded.has(entry.path) : undefined} disabled={entry.blocked || saving} onContextMenu={event => showMenu(event, entry)} onClick={() => {
        if (!entry.directory) { if (path !== entry.path) void openFile(entry.path); return; }
        const next = new Set(expanded);
        if (next.has(entry.path)) next.delete(entry.path); else { next.add(entry.path); if (!folders[entry.path]?.entries && !folders[entry.path]?.loading && workspace) void listFolder(entry.path, workspace, epoch.current); }
        setExpanded(next);
      }}>
        {entry.directory ? expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="qe-tree-spacer" />}
        {entry.directory ? expanded.has(entry.path) ? <FolderOpen size={15} /> : <FolderClosed size={15} /> : <FileIcon name={entry.name} />}
        <span>{entry.name}</span>
      </button>{entry.directory && expanded.has(entry.path) && renderFolder(entry.path, depth + 1)}
    </React.Fragment>) : <div className="qe-tree-message">Empty folder</div>;
  };

  const tree = useMemo(() => workspace ? renderFolder('', 0) : <div className="qe-tree-message">Choose a saved project above.</div>, [folders, expanded, path, saving, workspace, guard, listFolder, lease]);

  return <section className="qe-workspace" ref={container} aria-label="Quick Editor" onContextMenu={event => showMenu(event)}>
    <fieldset className="qe-session-controls" disabled={closing || transferring || working || !!naming || historyOpen}><header className="qe-heading">
      <div className="qe-heading-context"><h1><Code2 size={18} />Quick Editor</h1><select aria-label="Editor project" value={workspace?.id || ''} disabled={saving} onChange={event => guard(() => switchProject(projects.find(p => p.id === event.target.value)))}><option value="">Select a project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>{workspace && <ProjectServiceStatus project={workspace} />}</div>
      <div className="qe-heading-actions"><ProjectServiceAction project={workspace} /><Button tone="quiet" icon={<PanelBottom size={14} />} aria-pressed={logsOpen} aria-expanded={logsOpen} aria-controls="qe-service-logs" disabled={!workspace} title={logsOpen ? 'Hide project logs' : 'Show project logs'} onClick={() => setLogsOpen(value => !value)}>Logs</Button><Button tone="quiet" icon={floating ? <PanelBottomClose size={14} /> : <ExternalLink size={14} />} disabled={saving || loading || transferring || working || !!naming} onClick={() => void transfer()} title={floating ? 'Dock in DevFlow' : 'Open Quick Editor in its own window'}>{transferring ? 'Moving…' : floating ? 'Dock' : 'Float'}</Button></div>
    </header><ProjectServiceErrors project={workspace} />
    <div className="qe-session-layout" ref={layout}>
    <div className={`qe-frame ${collapsed ? 'is-collapsed' : ''}`} style={{ '--qe-width': `${width}px` } as React.CSSProperties}>
      {!collapsed && <><aside className="qe-explorer" aria-label="Project files"><div className="qe-explorer-heading"><span>EXPLORER</span><button title="Refresh file tree" aria-label="Refresh file tree" disabled={!workspace || saving} onClick={() => { setFolders({}); setExpanded(new Set([''])); if (workspace) void listFolder('', workspace, ++epoch.current); }}><RefreshCw size={13} /></button><button title="Collapse explorer" aria-label="Collapse explorer" onClick={() => setCollapsed(true)}><PanelLeftClose size={15} /></button></div><div className="qe-root" title={workspace?.root} onContextMenu={event => showMenu(event, rootEntry)}><FolderOpen size={14} /><strong>{workspace?.name || 'No project selected'}</strong></div><div className="qe-tree" onContextMenu={event => showMenu(event, rootEntry)}>{tree}</div><div className="qe-explorer-footer">Folders load on demand</div></aside>
      <div className="qe-divider" role="separator" tabIndex={0} aria-label="Resize file explorer; double-click to reset" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={400} aria-valuenow={width} onDoubleClick={() => setWidth(260)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(180, Math.min(400, value + (event.key === 'ArrowLeft' ? -10 : 10)))); } if (event.key === 'Home') setWidth(260); }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const left = container.current?.getBoundingClientRect().left || 0; const available = container.current?.clientWidth || 600; setWidth(Math.max(180, Math.min(400, available - 280, event.clientX - left))); } }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} /></>}
      <div className="qe-reader">
        {tabs.length > 0 && <div className="qe-tabs" role="tablist" aria-label="Open files" onKeyDown={event => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
          event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
        }}>{tabs.map(tab => <div className={`qe-tab ${tab.path === path ? 'is-active' : ''}`} key={tab.path}><button role="tab" aria-selected={tab.path === path} title={tab.path} onClick={() => selectTab(tab.path)} disabled={saving}><span>{tab.path}</span>{tabDirty(tab) && <span aria-label="Unsaved changes">●</span>}</button><button aria-label={`Close ${tab.path}`} title={`Close ${tab.path}`} disabled={saving || loading} onClick={() => {
          const remove = () => { const result = closeTab(tabs, path, tab.path); setTabs(result.tabs); setPath(result.active); setLoadedVersion(value => value + 1); };
          if (tabDirty(tab)) setConfirm({ description: `Discard unsaved changes in ${tab.path}?`, action: remove }); else remove();
        }}><X size={13} /></button></div>)}</div>}

        <div className="qe-filebar">{collapsed && <button title="Show explorer" aria-label="Show explorer" onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} /></button>}<div className="qe-filepath" title={path || workspace?.root}>{path ? <><FileIcon name={path} /><span>{path}</span>{dirty && <span className="qe-dirty" aria-label="Unsaved changes" />}</> : <span>Browse · read · copy · edit</span>}</div>{document && <div className="qe-modes" role="group" aria-label="File mode"><button aria-pressed={!editing} className={!editing ? 'is-active' : ''} onClick={() => setEditing(false)}>{markdown ? 'Preview' : 'View'}</button><button aria-pressed={editing} className={editing ? 'is-active' : ''} disabled={!writable || saving} title={!writable ? 'Read-only or mixed line endings' : 'Enable editing'} onClick={() => { setSurfaceOpened(true); setEditing(true); }}><Pencil size={12} />Edit</button></div>}</div>
        {document && <div className="qe-toolbar"><div className="qe-toolbar-group">{markdown && !editing ? <label ref={outlineSearch} className="qe-preview-search"><Search size={14} /><input aria-label="Find Markdown heading" placeholder="Find a heading…" value={previewSearch} onChange={event => { setPreviewSearch(event.target.value); setOutlineOpen(true); }} /></label> : <><button title="Find / replace (Ctrl+F / Ctrl+H)" aria-label="Find / replace" onClick={() => editor.current?.find()}><Search size={15} /></button><button title="Go to line" aria-label="Go to line" onClick={() => editor.current?.goToLine()}><ChevronsUpDown size={15} /></button></>}<button ref={outlineTrigger} aria-expanded={outlineOpen} title="Best-effort section outline" onClick={() => setOutlineOpen(!outlineOpen)}><ListTree size={15} /><span>Sections</span></button>{editing && <><button title="Undo (Ctrl+Z)" aria-label="Undo" disabled={saving} onClick={() => editor.current?.undo()}><RotateCcw size={14} /></button><button title="Redo (Ctrl+Y)" aria-label="Redo" disabled={saving} onClick={() => editor.current?.redo()}><RotateCw size={14} /></button></>}</div><div className="qe-toolbar-group"><button disabled={saving || loading || lease === undefined} onClick={() => setHistoryOpen(true)}>History</button><details ref={copyMenu} className="qe-copy-menu" open={copyOpen}><summary ref={copyTrigger} aria-expanded={copyOpen} onClick={event => { event.preventDefault(); setCopyOpen(value => !value); }}><Copy size={14} /><span>Copy</span><ChevronDown size={12} /></summary><div role="group" aria-label="Copy actions" onClickCapture={event => { if (event.target instanceof Element) { const button = event.target.closest<HTMLButtonElement>('button'); if (button && !button.disabled) { setCopyOpen(false); copyTrigger.current?.focus({ preventScroll: true }); } } }}><button onClick={() => void copy(dirty ? diskText(text, document) : document.content, 'Raw file copied')}><FileText size={14} />Entire file · raw text</button><button onClick={() => void copy(path, 'Relative path copied')}><Clipboard size={14} />Relative path</button><button disabled={(markdown && !editing) || !selection.selected} onClick={() => copySlice('selection')}><Copy size={14} />Selected code</button><button disabled={markdown && !editing} onClick={() => copySlice('lines')}><Code2 size={14} />Current line / line range</button><button disabled={markdown && !editing} title="Enclosing foldable section, or surrounding nonblank block" onClick={() => copySlice('section')}><Braces size={14} />Current code section</button></div></details><button className="qe-ai" title="Copy selection, or entire file when nothing is selected, with path and line numbers" onClick={() => copySlice(selection.selected && (!markdown || editing) ? 'selection' : 'all', true)}><Sparkles size={14} /><span>Copy for AI</span></button>{editing && <button className="qe-save" title="Save (Ctrl+S)" disabled={!dirty || saving || !writable || lease === undefined} onClick={() => void save()}>{saving ? <Loader2 size={14} className="qe-spin" /> : <Save size={14} />}<span>Save</span></button>}<button title="Reload disk version" aria-label="Reload disk version" disabled={saving || loading} onClick={() => { const action = () => void openFile(path, true); if (dirty) setConfirm({ description: `Discard unsaved edits in ${path} and reload its disk version?`, action }); else action(); }}><RefreshCw size={14} /></button></div></div>}
        {outlineOpen && document && <div ref={outline} className="qe-outline" aria-label="Section navigation"><div><span>SECTIONS · BEST EFFORT</span><button aria-label="Close sections" onClick={() => setOutlineOpen(false)}><X size={13} /></button></div>{sections.filter(s => s.label.toLowerCase().includes(previewSearch.toLowerCase())).map(s => <button key={s.line} onClick={() => jump(s.line, sections.indexOf(s))}><span>{s.label}</span><small>{s.line}</small></button>)}{!sections.length && <p>No named sections found. Use search or go to line.</p>}</div>}
        <OperationNotice message={error} dismiss={() => setError('')} />
        {loading && document && <div className="qe-opening" role="status"><Loader2 className="qe-spin" size={13} />Opening file…</div>}
        {loading && !document ? <div className="qe-empty" role="status"><Loader2 className="qe-spin" size={24} /><strong>Opening file…</strong><span>Reading a single file from your project.</span></div> : !document ? <div className="qe-empty"><span className="qe-empty-symbol"><Code2 size={27} strokeWidth={1.4} /></span><strong>A little space for focused work.</strong><span>Choose a file to read, copy context for AI,<br />or make a careful edit.</span><div><kbd>View first</kbd><ChevronRight size={12} /><kbd>Edit when ready</kbd></div></div> : <>
          {markdown && !editing && <div className="qe-preview" ref={preview}><Preview text={text} copy={(value, message) => void copy(value, message)} /></div>}
          {surfaceOpened && <div className="qe-surface" hidden={markdown && !editing}><Suspense fallback={<div className="qe-empty" role="status"><Loader2 className="qe-spin" size={20} />Loading editor…</div>}><EditorSurface key={`${workspace?.id}:${path}:${loadedVersion}`} ref={editor} content={text} path={path} line={logJump && logJump.projectId === workspace?.id && tabKey(logJump.path) === tabKey(path) ? logJump.line : undefined} editing={editing && !closing && !saving && !loading && !transferring && !working && !naming} onChange={setText} onSelection={(from, to, selected) => setSelection({ from, to, selected })} onSave={() => void latestSave.current()} onContextMenu={event => showMenu(event)} /></Suspense></div>}
        </>}
        <footer className="qe-status"><span role="status">{notice ? <><Check size={12} />{notice}</> : <>{dirty ? '● Unsaved changes' : editing ? 'Editing' : markdown && document ? 'Markdown preview' : 'Read-only view'}{document && <> · {extension(path).toUpperCase() || 'TEXT'}</>}</>}</span><span>{document && <>{markdown && !editing ? `${text.split('\n').length} lines` : `Ln ${selection.from}${selection.to !== selection.from ? `–${selection.to}` : ''}`}<span className="qe-status-detail"> · UTF-8{document.content.startsWith('\uFEFF') ? ' BOM' : ''} · {document.lineEnding}</span></>}{backup && <span title="Previous disk version stored in DevFlow local file history" className="qe-recovery"> · Local snapshot saved</span>}</span></footer>
      </div>
    </div>
    {pendingLogs.length > 0 && !pendingLogs.includes(workspace?.id || '') && <p role="status">Logs are waiting to dock. Select their project in Quick Editor; unsaved files remain protected.</p>}
    {logsOpen && workspace && <>
      <div hidden={logsCollapsed} className="qe-logs-divider" title="Drag to resize logs; double-click to reset" role="separator" tabIndex={0} aria-label="Resize logs panel" aria-orientation="horizontal" aria-valuemin={180} aria-valuemax={Math.max(180, Math.floor((layout.current?.clientHeight || 600) * .65))} aria-valuenow={logsHeight}
        onDoubleClick={() => setLogsHeight(330)} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const max = Math.max(180, Math.floor((layout.current?.clientHeight || 600) * .65)); setLogsHeight(value => event.key === 'Home' ? 180 : event.key === 'End' ? max : Math.max(180, Math.min(max, value + (event.key === 'ArrowUp' ? 20 : -20)))); } }}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const rect = layout.current?.getBoundingClientRect(); if (rect) setLogsHeight(Math.max(180, Math.min(Math.floor(rect.height * .65), rect.bottom - event.clientY))); } }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <section id="qe-service-logs" className={`qe-bottom-logs ${logsCollapsed ? 'is-collapsed' : ''}`} aria-label="Project logs" style={{ '--logs-height': `${logsHeight}px` } as React.CSSProperties} onContextMenu={event => event.stopPropagation()}>
        <LogsHeader project={workspace} onFloat={() => void floatLogs(workspace).then(() => { setLogsOpen(false); setError(''); }).catch(cause => setError(errorMessage(cause)))} collapsed={logsCollapsed} onCollapse={() => setLogsCollapsed(value => !value)} onHide={() => setLogsOpen(false)} />
        <div className="qe-logs-content" hidden={logsCollapsed}>{visible && <ProjectLogs key={workspace.id} project={workspace} />}</div>
      </section>
    </>}
    </div>
    </fieldset>
    {historyOpen && workspace && document && <EditorHistory project={workspace} path={path} dirty={dirty} close={() => setHistoryOpen(false)} restore={async (id, expected) => {
      if (closeLock.current || saveLock.current || workLock.current || transferLock.current || lease === undefined) throw new Error('Wait for the current editor operation to finish.');
      if (tabsRef.current.some(tab => tabKey(tab.path) === tabKey(path) && tabDirty(tab))) throw new Error('Unsaved edits are protected. Save or discard them before restoring.');
      workLock.current = true; setWorking(true);
      try {
        const result = await editorApi.restore(workspace, path, id, expected, lease);
        setTabs(current => current.map(tab => tabKey(tab.path) === tabKey(path) ? { ...tab, document: result, baseline: normalizeText(result.content), text: normalizeText(result.content), backup: '', editing: false } : tab));
        setLoadedVersion(value => value + 1); setNotice('Snapshot restored · previous disk version preserved'); setError('');
      } catch (cause) {
        setError(`Restore did not complete normally. Reload the disk version before editing: ${errorMessage(cause)}`, true);
        throw cause;
      } finally { workLock.current = false; setWorking(false); }
    }} />}
    {working && <p role="status" className="qe-copy-warning">Working locally…</p>}
    {!!copyWarnings.length && <div className="qe-copy-warning" role="status"><strong>Copy was filtered or incomplete.</strong>{copyWarnings.map(warning => <div key={warning}>{warning}</div>)}<button onClick={() => setCopyWarnings([])}>Dismiss</button></div>}
    {menu && <EditorContextMenu x={menu.x} y={menu.y} actions={menuActions()} close={() => setMenu(undefined)} />}
    {naming && <EditorNameDialog title={naming.action === 'rename' ? `Rename ${naming.entry.name}` : naming.action === 'file' ? 'New File' : 'New Folder'} initial={naming.action === 'rename' ? naming.entry.name : ''} busy={working} error={nameError} submit={name => void applyName(name)} close={() => { setNaming(undefined); setNameError(''); }} />}
    {confirm && createPortal(<ConfirmDialog title="Unsaved file changes" description={confirm.description} confirmText="Discard and continue" destructive onCancel={() => { confirm.cancel?.(); setConfirm(undefined); }} onConfirm={() => { const action = confirm.action; setConfirm(undefined); action(); }} />, window.document.body)}
  </section>;
}
