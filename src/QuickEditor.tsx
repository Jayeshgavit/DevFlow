import CopyReview from './CopyReview';
import { useExternalFileSync } from './use-external-file-sync';
import { prepareAiContent } from './ai-api';
import { HelpLink } from './UserGuide';
import { useOperationError } from './use-operation-error';
import { OperationNotice } from './NotificationCenter';
import { errorMessage } from './operation-error';
import React, { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Braces, Check, ChevronDown, ChevronRight, ChevronsUpDown, Clipboard, Code2, Copy, FileCode2, FileText, FolderClosed, FolderOpen, ListTree, Loader2, PanelLeftClose, PanelLeftOpen, Pencil, RefreshCw, RotateCcw, RotateCw, Save, Search, ExternalLink, PanelBottom, PanelBottomClose, Sparkles, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, ConfirmDialog } from './components';
import type { Project } from './types';
import { aiContext, diskText, editorApi, extension, isMarkdown, normalizeText, type FileEntry, type CopyExport } from './editor-api';
import type { EditorHandle } from './EditorSurface';
import { closeTab, renameTabs, renamedPath, sessionDirty, tabDirty, tabKey, type EditorSession, type EditorTab } from './editor-session';
import { EditorContextMenu, EditorNameDialog, type MenuAction } from './EditorContextMenu';
import { useMenuDismissal } from './menu-dismissal';
import EditorHistory from './EditorHistory';
import SmartReplace, { type SmartReview, type SmartTarget } from './SmartReplace';
import PasteAsNewFile from './PasteAsNewFile';
import { parseNewFiles } from './paste-new-file';
import type { NewFileInput, NewFileOutcome, ProjectReplaceFile, ProjectReplaceOutcome } from './editor-api';
import { parseClipboard, relativeClipboardPath, type ClipboardBlock, type ReplaceRange } from './smart-replace';
import './quick-editor.css';
import { ProjectServiceAction, ProjectServiceErrors, ProjectServiceStatus } from './ProjectServiceControls';
import { LogsHeader, ProjectLogs, floatLogs } from './SharedLogs';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AI_ATTACHMENT_LIMIT, readContextBudget, attachmentDuplicate, contextByteSize, fileAttachment, logAttachment, projectContextAttachment, safeAiContext, selectionAttachment, type AiAttachment } from './ai-context';
import type { LogEntry } from './log-utils';

const EditorSurface = lazy(() => import('./EditorSurface'));
import AiAssistantPanel, { clampAiWidth, type AiProvider, type ChatMessage } from './AiAssistantPanel';
import BrainQueue from './BrainQueue';
import ProjectSearch from './ProjectSearch';
type FolderState = { entries?: FileEntry[]; error?: string; loading?: boolean };
const initialWidth = () => { try { return Math.max(180, Math.min(400, Number(localStorage.getItem('devflow-editor-width')) || 260)); } catch { return 260; } };
const initialAiWidth = () => { try { return Math.max(260, Math.min(550, Number(localStorage.getItem('devflow-ai-width')) || 340)); } catch { return 340; } };
const initialAiOpen = () => { try { return localStorage.getItem('devflow-ai-open') === 'true'; } catch { return false; } };
const initialAiProvider = (): AiProvider => { try { const stored = localStorage.getItem('devflow-ai-provider'); return stored === 'nvidia-nim' ? 'nvidia-nim' : 'openrouter'; } catch { return 'openrouter'; } };

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
  type LogLocation = { projectId: string; path: string; line: number; column?: number };
  const [pendingLocation, setPendingLocation] = useState<LogLocation>();
  const [logJump, setLogJump] = useState<LogLocation>();
  const [workspace, setWorkspace] = useState<Project | undefined>(initial ? initial.workspace : (() => { try { return projects.find(p => p.id === localStorage.getItem('devflow-editor-project')) || selected || projects[0]; } catch { return selected || projects[0]; } })());
  const workspaceRef = useRef(workspace); workspaceRef.current = workspace;
  const [logsOpen, setLogsOpen] = useState(initial?.layout?.logsOpen || false);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [logsHeight, setLogsHeight] = useState(initial?.layout?.logsHeight || 330);
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
  const [expanded, setExpanded] = useState(new Set(initial?.layout?.expanded || ['']));
  const [tabs, setTabsState] = useState<EditorTab[]>(initial?.tabs || []);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  // Disk reads and input callbacks must observe the latest draft before React
  // commits a render; never base a disk replacement on a stale render closure.
  const setTabs = useCallback((action: React.SetStateAction<EditorTab[]>) => {
    const next = typeof action === 'function' ? action(tabsRef.current) : action;
    tabsRef.current = next; setTabsState(next);
  }, []);
  const [path, setPath] = useState(initial?.active || '');
  const active = tabs.find(tab => tabKey(tab.path) === tabKey(path));
  const document = active?.document;
  const text = active?.text || '';
  const editing = active?.editing || false;
  const surfaceOpened = active?.surfaceOpened || false;
  const updateTab = (patch: Partial<EditorTab>) => setTabs(current => current.map(tab => tabKey(tab.path) === tabKey(path) ? { ...tab, ...patch } : tab));
  const setText = (text: string) => updateTab({ text, updatedFromDisk: false });
  const setEditing = (editing: boolean) => updateTab({ editing });
  const setSurfaceOpened = (surfaceOpened: boolean) => updateTab({ surfaceOpened });
  const [loading, setLoading] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [externalComparison, setExternalComparison] = useState<{ path: string; disk: string }>();
  const [smart, setSmart] = useState<{ blocks: ClipboardBlock[]; selection?: ReplaceRange }>();
  const [pasting, setPasting] = useState<{ blocks: ClipboardBlock[]; folder: string }>();
  const smartReading = useRef(false);
  const [error, setError] = useOperationError();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!active?.updatedFromDisk) return;
    const target = active.path, revision = active.syncRevision;
    const timer = setTimeout(() => setTabs(tabs => tabs.map(tab => tabKey(tab.path) === tabKey(target) && tab.syncRevision === revision ? { ...tab, updatedFromDisk: false } : tab)), 3500);
    return () => clearTimeout(timer);
  }, [path, active?.syncRevision, active?.updatedFromDisk, setTabs]);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const showProjectSearch = () => { setCollapsed(false); setSearchOpen(true); setSearchFocus(value => value + 1); };
  useEffect(() => {
    const search = (event: Event) => {
      if (!visible || !workspace || container.current?.closest('[hidden]') || closing || saving || transferring || working || naming || smart || pasting || historyOpen) return;
      event.preventDefault(); showProjectSearch();
    };
    window.addEventListener('devflow-editor-project-search', search);
    return () => window.removeEventListener('devflow-editor-project-search', search);
  }, [visible, workspace, closing, saving, transferring, working, naming, smart, pasting, historyOpen]);
  const [aiOpen, setAiOpen] = useState(initial?.ai?.open ?? initialAiOpen);
  const [aiWidth, setAiWidth] = useState(initial?.ai?.width ?? initialAiWidth);
  const [aiProvider, setAiProvider] = useState<AiProvider>(initial?.ai?.provider ?? initialAiProvider);
  const [aiAttachments, setAiAttachments] = useState<AiAttachment[]>(initial?.ai?.attachments || []);
  const aiAttachmentsRef = useRef(aiAttachments); aiAttachmentsRef.current = aiAttachments;
  const updateAiAttachments = useCallback((next: AiAttachment[]) => { aiAttachmentsRef.current = next; setAiAttachments(next); }, []);
  const [checkedLogEntries, setCheckedLogEntries] = useState<LogEntry[]>([]);
  const [aiModel, setAiModel] = useState(() => { try { return initial?.ai?.model ?? localStorage.getItem('devflow-ai-model') ?? ''; } catch { return ''; } });
  const [aiDraft, setAiDraft] = useState(initial?.ai?.draft || '');
  const aiMessages = useRef<ChatMessage[]>(initial?.ai?.messages || []);
  const aiStreaming = useRef(false);
  const flushAi = useRef<() => Promise<void>>(async () => {});
  const aiReviewed = useRef(initial?.ai?.reviewed || '');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [copyScope, setCopyScope] = useState<'selection' | 'section' | 'all'>('all');
  const [copyBudget, setCopyBudget] = useState(() => { try { const value = Number(localStorage.getItem('devflow-editor-copy-budget')); return [16384, 65536, 131072, 262144, 524288].includes(value) ? value : 65536; } catch { return 65536; } });
  const copyBudgetRef = useRef(copyBudget); copyBudgetRef.current = copyBudget;
  const [copyReview, setCopyReview] = useState<{ result: CopyExport; valid: () => boolean; refresh: () => Promise<CopyExport> }>();
  useEffect(() => { try { localStorage.setItem('devflow-editor-copy-budget', String(copyBudget)); } catch { /* Keep session preference. */ } }, [copyBudget]);
  useEffect(() => { setCopyReview(undefined); }, [workspace?.id, workspace?.root, path, tabs, copyScope, copyBudget, selection, lease, transferring, closing]);
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
  const smartContext = useRef({ workspace, path, lease, text, loadedVersion });
  smartContext.current = { workspace, path, lease, text, loadedVersion };
  useEffect(() => { setSmart(undefined); }, [workspace?.id, workspace?.root, path, lease, loadedVersion, text]);
  useEffect(() => { setPasting(undefined); }, [workspace?.id, workspace?.root, lease, transferring, closing]);

  const startPasteNew = async (folder = '') => {
    if (!workspace || lease === undefined || smartReading.current || smart || pasting || naming || historyOpen || loading || saving || working || transferring || closing) return;
    smartReading.current = true;
    const context = smartContext.current;
    try {
      const blocks = parseNewFiles(await navigator.clipboard.readText());
      const current = smartContext.current;
      if (current.workspace?.id !== context.workspace?.id || current.workspace?.root !== context.workspace?.root || current.lease !== context.lease || workLock.current || saveLock.current || transferLock.current || closeLock.current) throw new Error('Project or editor ownership changed. Try again.');
      setPasting({ blocks, folder });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { smartReading.current = false; }
  };

  const startSmartReplace = async () => {
    if (!workspace || !active || lease === undefined || smartReading.current || smart || historyOpen || loading || saving || working || transferring || closing) return;
    smartReading.current = true;
    const context = smartContext.current;
    const selected = editor.current?.selectionRange();
    try {
      const blocks = parseClipboard(await navigator.clipboard.readText());
      if ((smartContext.current.workspace?.id !== context.workspace?.id || smartContext.current.workspace?.root !== context.workspace?.root || smartContext.current.path !== context.path || smartContext.current.lease !== context.lease || smartContext.current.text !== context.text || smartContext.current.loadedVersion !== context.loadedVersion)) throw new Error('Editor changed while reading the clipboard. Try again.');
      setSmart({ blocks, selection: selected ? { ...selected, label: 'Current editor selection' } : undefined });
    } catch (cause) { setError(errorMessage(cause)); }
    finally { smartReading.current = false; }
  };

  const loadSmartTarget = async (next: string): Promise<SmartTarget> => {
    if (!workspace) throw new Error('Select a saved project.');
    relativeClipboardPath(next);
    const tab = tabsRef.current.find(tab => tabKey(tab.path) === tabKey(next));
    // Reuse Rust export guards for exclusions, secrets, UTF-8, saved roots,
    // ignored paths, linked directories, and the conservative 256 KiB limit.
    await editorApi.validateAiFile(workspace, next, tab?.text || '');
    const disk = await editorApi.read(workspace, next);
    if (disk.readOnly || disk.lineEnding === 'mixed') throw new Error('Read-only and mixed-line-ending files cannot be replaced.');
    if (tab && tab.document.content !== disk.content) throw new Error('File changed externally. Reconcile the tab with disk before Smart Replace.');
    const text = normalizeText(disk.content);
    return { disk: disk.content, tab: tab || { path: next, document: disk, baseline: text, text, editing: false, surfaceOpened: true, backup: '' } };
  };

  const searchSmartTargets = async (name: string) => {
    if (!workspace || /^(app|main|index|default|render|test|init)$/i.test(name)) return [];
    const result: string[] = [], queue = [''];
    let entries = 0, directories = 0;
    const skip = /^(?:\.|node_modules$|vendor$|dist$|build$|target$|out$|coverage$|venv$|__pycache__$|bin$|obj$|secrets$|credentials$|keys$|certs$)/i;
    while (queue.length && directories++ < 24 && entries < 400 && result.length < 20) {
      const folder = queue.shift()!;
      const listed = await editorApi.list(workspace, folder);
      for (const entry of listed) {
        if (++entries > 400) break;
        if (entry.blocked || skip.test(entry.name)) continue;
        if (entry.directory) { if (entry.path.split('/').length < 4) queue.push(entry.path); }
        else if (entry.name.split('.')[0].toLowerCase() === name.toLowerCase()) {
          try { await editorApi.validateAiFile(workspace, entry.path, ''); result.push(entry.path); } catch { /* Excluded files never become candidates. */ }
        }
      }
    }
    return result;
  };

  const applySmartReplace = async (review: SmartReview) => {
    if (!workspace || lease === undefined || closeLock.current || saveLock.current || workLock.current || transferLock.current || loading) throw new Error('Editor is busy. Reopen Smart Replace.');
    const context = smartContext.current;
    workLock.current = true; setWorking(true);
    try {
      await editorApi.validateAiFile(workspace, review.target.tab.path, review.result);
      const disk = await editorApi.read(workspace, review.target.tab.path);
      const owner = await editorApi.lease();
      if (owner !== lease || (smartContext.current.workspace?.id !== context.workspace?.id || smartContext.current.workspace?.root !== context.workspace?.root || smartContext.current.path !== context.path || smartContext.current.lease !== context.lease || smartContext.current.text !== context.text || smartContext.current.loadedVersion !== context.loadedVersion) || disk.content !== review.target.disk) throw new Error('Source, project, or writer ownership changed. Reopen and review again.');
      const existing = tabsRef.current.find(tab => tabKey(tab.path) === tabKey(review.target.tab.path));
      if (existing && (existing.text !== review.target.tab.text || existing.document.content !== review.target.tab.document.content)) throw new Error('Draft changed after preview. Reopen Smart Replace.');
      if (!existing && (tabsRef.current.length >= 20 || tabsRef.current.reduce((size, tab) => size + tab.text.length + tab.document.content.length, 0) >= 16 * 1024 * 1024)) throw new Error('Close some tabs before applying to another file.');
      if (tabKey(path) === tabKey(review.target.tab.path) && editor.current && !editor.current.replaceRange(review.target.tab.text, review.range.from, review.range.to, review.insertion)) throw new Error('Editor source changed. Reopen and review again.');
      const updated = { ...(existing || review.target.tab), text: review.result, editing: true, surfaceOpened: true };
      const next = existing ? tabsRef.current.map(tab => tab === existing ? updated : tab) : [...tabsRef.current, updated];
      tabsRef.current = next; setTabs(next);
      if (tabKey(path) !== tabKey(updated.path)) selectTab(updated.path);
      setNotice('Replacement applied to draft · Ctrl+S to save and create a snapshot');
    } finally { workLock.current = false; setWorking(false); }
  };

  const guard = useCallback((action: () => void) => {
    if (saveLock.current || workLock.current) return;
    if (unsaved.current) setConfirm({ description: 'Open files have unsaved edits. Discard them and continue? Copy your changes first if you need to keep them.', action });
    else action();
  }, []);

  const folderRequests = useRef(new Map<string, number>());
  const listFolder = useCallback(async (folder: string, project: Project, generation: number, background = false) => {
    const request = (folderRequests.current.get(folder) || 0) + 1;
    folderRequests.current.set(folder, request);
    if (!background) setFolders(current => ({ ...current, [folder]: { ...current[folder], loading: true, error: undefined } }));
    try {
      const entries = await editorApi.list(project, folder);
      if (epoch.current === generation && folderRequests.current.get(folder) === request) setFolders(current => ({ ...current, [folder]: { entries } }));
    } catch (cause) { if (!background && epoch.current === generation && folderRequests.current.get(folder) === request) setFolders(current => ({ ...current, [folder]: { error: errorMessage(cause) } })); }
  }, []);

  const addAiAttachment = useCallback(async (attachment: Omit<AiAttachment, 'id'>) => {
    try {
      if (attachment.projectId !== workspaceRef.current?.id) return;
      const prepared = await prepareAiContent(attachment.content);
      if (attachment.projectId !== workspaceRef.current?.id) return;
      const content = safeAiContext(prepared.content, Math.min(readContextBudget(), AI_ATTACHMENT_LIMIT), true);
      attachment = { ...attachment, sanitization: [attachment.sanitization, prepared.lines.length ? `Sanitized context lines: ${prepared.lines.join(', ')}.` : ''].filter(Boolean).join(' ') };
      const existing = aiAttachmentsRef.current.some(item => item.projectId !== attachment.projectId) ? [] : aiAttachmentsRef.current;
      if (existing.reduce((size, item) => size + contextByteSize(item.content), 0) + contextByteSize(content) > readContextBudget()) throw new Error(`${attachment.label}: Combined attachments exceed the selected budget. Select a smaller range, remove an attachment, or change the budget.`);
      if (attachmentDuplicate(existing, { ...attachment, content })) { setNotice('Already attached · remove the existing snapshot before replacing it'); return; }
      const next = [...existing, { ...attachment, id: `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, content }];
      aiAttachmentsRef.current = next;
      updateAiAttachments(next);
      setError('');
    } catch (cause) { setError(`${attachment.label}: ${errorMessage(cause)} Select a smaller range or change the budget. Individual cap: 256 KiB.`); }
  }, [setError, updateAiAttachments]);

  const attachCurrentFile = async () => {
    if (!workspace || !document || !path || loading || working || saving) return;
    const attachmentsAtStart = aiAttachmentsRef.current;
    try {
      let source = dirty ? diskText(text, document) : document.content;
      const prepared = await editorApi.prepareAiFile(workspace, path, source);
      if (aiAttachmentsRef.current !== attachmentsAtStart || workspaceRef.current?.id !== workspace.id || workspaceRef.current?.root !== workspace.root) return;
      source = prepared.text;
      const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', rs: 'rust', json: 'json', md: 'markdown', html: 'html', css: 'css' } as Record<string, string>)[extension(path)] || 'text';
      const fenceSize = Array.from(source.matchAll(/`+/g), match => match[0].length + 1).reduce((max, size) => Math.max(max, size), 3);
      const fence = '`'.repeat(fenceSize);
      addAiAttachment({ ...fileAttachment(workspace.id, workspace.name, path, language, `${fence}${language}\n${source}\n${fence}`, dirty), sanitization: prepared.warnings.join(" ") });
    } catch (cause) { setError(`${errorMessage(cause)} AI sharing is blocked when a file is sensitive, excluded, unsupported, or exceeds the secure export limit.`); }
  };

  const attachSelectedCode = async () => {
    if (!workspace || !document || !selection.selected || loading || saving || working) return;
    const attachmentsAtStart = aiAttachmentsRef.current;
    try {
      const slice = editor.current?.slice('selection');
      if (!slice?.text) { setError('Select code in the editor before attaching it.'); return; }
      await editorApi.prepareAiFile(workspace, path, normalizeText(dirty ? text : document.content));
      if (aiAttachmentsRef.current !== attachmentsAtStart || workspaceRef.current?.id !== workspace.id || workspaceRef.current?.root !== workspace.root) return;
      const language = extension(path).toLowerCase() || 'text';
      const fenceSize = Array.from(slice.text.matchAll(/`+/g), match => match[0].length + 1).reduce((max, size) => Math.max(max, size), 3);
      const fence = '`'.repeat(fenceSize);
      addAiAttachment(selectionAttachment(workspace.id, workspace.name, path, language, `${fence}${language}\n${slice.text}\n${fence}`, slice.from, slice.to, dirty));
    } catch (cause) { setError(`${errorMessage(cause)} AI sharing is blocked when a file is sensitive, excluded, unsupported, or exceeds the secure export limit.`); }
  };

  const attachProjectContext = async () => {
    if (!workspace || loading || working) return;
    const attachmentsAtStart = aiAttachmentsRef.current;
    try {
      const tree = await editorApi.export(workspace, '', 'tree');
      if (aiAttachmentsRef.current !== attachmentsAtStart || workspaceRef.current?.id !== workspace.id || workspaceRef.current?.root !== workspace.root) return;
      addAiAttachment(projectContextAttachment(workspace.id, workspace.name, workspace.services, tree.text));
    } catch (cause) { setError(`Could not create project context: ${errorMessage(cause)}`); }
  };

  const attachLogs = useCallback((entries: LogEntry[], label: string) => {
    if (!workspace) return;
    try { addAiAttachment(logAttachment(workspace.id, workspace.name, workspace.services, entries, label)); }
    catch (cause) { setError(errorMessage(cause)); }
  }, [workspace, addAiAttachment, setError]);

  const switchProject = useCallback((project?: Project) => {
    if (aiStreaming.current) { setError('Stop the AI response before switching projects.'); return; }
    void flushAi.current().catch(cause => setError(String(cause)));
    aiMessages.current = []; aiReviewed.current = ''; setAiDraft('');
    epoch.current++; fileRequest.current++;
    workspaceRef.current = project; updateAiAttachments([]); setWorkspace(project); setCheckedLogEntries([]); setFolders({}); setExpanded(new Set([''])); setPath(''); setTabs([]); setError(''); setNotice(''); setLoading(false);
    if (project) void listFolder('', project, epoch.current);
  }, [listFolder, updateAiAttachments]);

  useEffect(() => { if (workspace) void listFolder('', workspace, epoch.current); }, []);
  const restoredWorkspace = useRef('');
  useEffect(() => {
    if (!workspace || lease === undefined || restoredWorkspace.current === workspace.id) return;
    restoredWorkspace.current = workspace.id;
    if (initial) return;
    let disposed = false;
    const project = workspace;
    void (async () => {
      try {
        const raw = JSON.parse(localStorage.getItem(`devflow-workspace:${project.id}`) || 'null');
        if (!raw || raw.root !== project.root) return;
        setLogsOpen(raw.logsOpen === true); setLogsHeight(Math.max(180, Math.min(600, Number(raw.logsHeight) || 330)));
        const folders = Array.isArray(raw.expanded) ? raw.expanded.filter((p: unknown): p is string => typeof p === 'string').slice(0, 100) : [''];
        for (const folder of folders) { if (disposed) return; await listFolder(folder, project, epoch.current); }
        if (!disposed) setExpanded(new Set(folders));
        const paths: string[] = Array.isArray(raw.paths) ? [...new Set<string>(raw.paths.filter((p: unknown): p is string => typeof p === 'string'))].slice(0, 20) : [];
        const restored: EditorTab[] = [];
        for (const file of paths) {
          if (disposed) return;
          try {
            // Guarded export checks exclusions before restoring any file contents.
            const allowed = await editorApi.export(project, file, 'file'); if (!allowed.files) continue;
            const document = await editorApi.read(project, file); const text = normalizeText(document.content);
            restored.push({ path: file, document, baseline: text, text, editing: false, surfaceOpened: !isMarkdown(file), backup: '' });
          } catch { /* Missing or excluded paths are not restored. */ }
        }
        if (!disposed) { setTabs(current => current.length ? current : restored); setPath(current => current || restored.find(t => t.path === raw.active)?.path || restored[0]?.path || ''); }
      } catch { /* Invalid optional UI metadata is ignored. */ }
    })();
    return () => { disposed = true; };
  }, [workspace?.id, lease]);
  useEffect(() => {
    if (!workspace || lease === undefined) return;
    const timer = setTimeout(() => { try {
      localStorage.setItem('devflow-editor-project', workspace.id);
      localStorage.setItem(`devflow-workspace:${workspace.id}`, JSON.stringify({ root: workspace.root, paths: tabs.map(t => t.path).slice(-20), active: path, expanded: [...expanded].slice(0, 100), logsOpen, logsHeight }));
    } catch { /* Workspace remains usable when optional metadata storage is full. */ } }, 1000);
    return () => clearTimeout(timer);
  }, [workspace, lease, tabs, path, expanded, logsOpen, logsHeight]);

  useEffect(() => {
    if (workspace && !projects.some(p => p.id === workspace.id)) {
      // Keep an orphaned draft available to copy after a project is removed.
      if (unsaved.current) setError('This project was removed. Copy your unsaved edits before choosing another project.', true);
      else switchProject(undefined);
    }
  }, [projects, workspace, switchProject]);
  useEffect(() => { try { localStorage.setItem('devflow-editor-width', String(width)); } catch { /* Optional preference. */ } }, [width]);
  useEffect(() => { try { localStorage.setItem('devflow-ai-open', String(aiOpen)); } catch { /* Optional preference. */ } }, [aiOpen]);
  useEffect(() => { try { localStorage.setItem('devflow-ai-width', String(aiWidth)); } catch { /* Optional preference. */ } }, [aiWidth]);
  useEffect(() => { try { localStorage.setItem('devflow-ai-provider', aiProvider); } catch { /* Optional preference. */ } }, [aiProvider]);
  useEffect(() => { try { localStorage.setItem('devflow-ai-model', aiModel); } catch { /* Optional preference. */ } }, [aiModel]);
  useEffect(() => { try { sessionStorage.setItem('devflow-ai-draft', aiDraft); } catch { /* Optional preference. */ } }, [aiDraft]);
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
        setConfirm({ description: 'Close and discard all open files’ unsaved edits? Copy your changes first if you need to keep them.', action: () => { void flushAi.current().then(() => request.detail(true)).catch(cause => { setError(String(cause)); request.detail(false); }); }, cancel: () => request.detail(false) });
      } else { if (aiStreaming.current) { setError('Stop the AI response before closing; partial messages are retained.'); request.detail(false); } else void flushAi.current().then(() => request.detail(true)).catch(cause => { setError(String(cause)); request.detail(false); }); }
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

  const rememberPosition = () => {
    const position = editor.current?.position();
    if (!position) return tabsRef.current;
    const next = tabsRef.current.map(tab => tabKey(tab.path) === tabKey(path) ? { ...tab, position } : tab);
    tabsRef.current = next; setTabs(next); return next;
  };
  const transferLock = useRef(false);
  useExternalFileSync({ project: workspace, lease, tabs, setTabs,
    blocked: saving || loading || working || transferring || closing || !!naming || !!smart || !!pasting || historyOpen,
    blockedNow: () => saveLock.current || workLock.current || transferLock.current || closeLock.current,
    refresh: parents => { if (workspace) for (const parent of parents) if (expanded.has(parent)) void listFolder(parent, workspace, epoch.current, true); },
    error: message => setError(message),
  });
  useEffect(() => { setExternalComparison(undefined); }, [workspace?.id, workspace?.root, path, lease]);
  const transfer = async () => {
    if (closeLock.current || saveLock.current || workLock.current || loading || transferLock.current || naming) return;
    transferLock.current = true; setTransferring(true); setError('');
    try { if (aiStreaming.current) throw new Error('Stop the AI response before moving the editor. Partial responses are retained.'); await flushAi.current(); await onTransfer({ workspace, tabs: rememberPosition(), active: path, width, collapsed, layout: { logsOpen, logsHeight, expanded: [...expanded] }, ai: { open: aiOpen, width: aiWidth, provider: aiProvider, model: aiModel, draft: aiDraft, messages: aiMessages.current, attachments: aiAttachments, reviewed: aiReviewed.current } }); }
    catch (cause) {
      setError(errorMessage(cause), true);
      // A failed window creation rotates the backend lease while retaining this draft.
      try { setLease(await editorApi.lease()); } catch { setLease(undefined); }
    }
    finally { transferLock.current = false; setTransferring(false); }
  };
  const selectTab = (next: string) => {
    rememberPosition();
    fileRequest.current++; setLoading(false); setPath(next); setLoadedVersion(value => value + 1);
    setSelection({ from: 1, to: 1, selected: false }); setNotice(''); setError(''); setPreviewSearch(''); setOutlineOpen(false);
  };
  const cycleTab = useRef<(direction: number) => boolean>(() => false);
  cycleTab.current = direction => {
    if (!visible || container.current?.closest('[hidden]') || saving || loading || transferring || working || naming || smart || pasting || historyOpen || closing || tabsRef.current.length === 0) return false;
    const files = tabsRef.current;
    const index = files.findIndex(tab => tabKey(tab.path) === tabKey(path));
    selectTab(files[(Math.max(0, index) + direction + files.length) % files.length].path);
    requestAnimationFrame(() => container.current?.querySelector<HTMLElement>('.cm-content')?.focus());
    return true;
  };
  useEffect(() => {
    const cycle = (event: Event) => { if (cycleTab.current((event as CustomEvent<number>).detail)) event.preventDefault(); };
    window.addEventListener('devflow-editor-cycle', cycle);
    return () => window.removeEventListener('devflow-editor-cycle', cycle);
  }, []);
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
      if (reload && existing && tabsRef.current.find(tab => tabKey(tab.path) === tabKey(next))?.text !== existing.text) throw new Error('Draft changed while reloading. Review it and try again.');
      const tab: EditorTab = { path: next, document: result, baseline: normalizeText(result.content), text: normalizeText(result.content), editing: false, surfaceOpened: !isMarkdown(next), backup: '' };
      setTabs(current => existing ? current.map(item => tabKey(item.path) === tabKey(next) ? tab : item) : [...current, tab]); setPath(next); setLoadedVersion(value => value + 1); setSelection({ from: 1, to: 1, selected: false }); setPreviewSearch('');
    } catch (cause) { if (request === fileRequest.current) setError(errorMessage(cause)); }
    finally { if (request === fileRequest.current) setLoading(false); }
  };

  const applyProjectReplacement = async (files: ProjectReplaceFile[]): Promise<ProjectReplaceOutcome> => {
    if (!workspace || lease === undefined || saveLock.current || workLock.current || transferLock.current || closeLock.current || loading) throw new Error('Editor is busy. Review the replacement again.');
    if (!files.length || files.length > 100) throw new Error('Review 1–100 files at a time.');
    const project = workspace, token = lease;
    const targets = new Set(files.map(file => tabKey(file.path)));
    const checkDrafts = () => {
      if (tabsRef.current.some(tab => targets.has(tabKey(tab.path)) && tabDirty(tab))) throw new Error('A target file has unsaved edits. Save or discard that draft, then review again.');
      if (workspaceRef.current?.id !== project.id || workspaceRef.current?.root !== project.root || smartContext.current.lease !== token) throw new Error('Project or editor ownership changed. Review again.');
    };
    checkDrafts();
    workLock.current = true; setWorking(true);
    const applied: string[] = [];
    try {
      if (await editorApi.lease() !== token) throw new Error('Editor ownership changed. Review again.');
      // Preflight the entire review before the first write; each save also checks disk.
      for (const file of files) {
        checkDrafts();
        const disk = await editorApi.read(project, file.path);
        if (disk.content !== file.expected.content || disk.readOnly || disk.lineEnding === 'mixed') throw new Error(`${file.path} changed or is not writable. No replacements started; review again.`);
      }
      for (const file of files) {
        checkDrafts();
        let backup: string;
        try { backup = await editorApi.save(project, file.path, file.expected.content, file.content, token); }
        catch (cause) { throw new Error(`${file.path}: ${errorMessage(cause)}`); }
        applied.push(file.path);
        setTabs(current => current.map(tab => tabKey(tab.path) === tabKey(file.path) && !tabDirty(tab) && tab.document.content === file.expected.content ? {
          ...tab, document: { ...file.expected, content: file.content }, baseline: normalizeText(file.content), text: normalizeText(file.content), backup,
          syncRevision: (tab.syncRevision || 0) + 1, external: undefined, updatedFromDisk: true,
        } : tab));
      }
      return { applied };
    } catch (cause) { return { applied, error: errorMessage(cause) }; }
    finally { workLock.current = false; setWorking(false); }
  };

  const compareExternal = async () => {
    if (!workspace || !active || lease === undefined || transferLock.current || closeLock.current) return;
    const project = workspace, target = active.path, token = lease, generation = epoch.current;
    try {
      const disk = await editorApi.read(project, target);
      if (generation !== epoch.current || smartContext.current.path !== target || smartContext.current.lease !== token || transferLock.current || closeLock.current || await editorApi.lease() !== token) return;
      setExternalComparison({ path: target, disk: normalizeText(disk.content) });
    } catch (cause) { setError(`Could not compare disk content: ${errorMessage(cause)}`); }
  };
  const reloadExternal = async () => {
    if (!workspace || !active || lease === undefined || saveLock.current || workLock.current || transferLock.current || closeLock.current) return;
    const project = workspace, original = active, token = lease, generation = epoch.current;
    const valid = () => generation === epoch.current && smartContext.current.path === original.path && smartContext.current.lease === token && !transferLock.current && !closeLock.current && !saveLock.current && !workLock.current && tabsRef.current.find(tab => tabKey(tab.path) === tabKey(original.path))?.text === original.text;
    try {
      const reviewed = await editorApi.read(project, original.path);
      if (!valid()) throw new Error('Draft or editor session changed. Review and reload again.');
      const apply = async () => {
        try {
          if (!valid()) throw new Error('Draft or editor session changed since confirmation. Reload again.');
          const disk = await editorApi.read(project, original.path);
          if (await editorApi.lease() !== token || !valid()) throw new Error('Draft or editor ownership changed. Reload again.');
          if (disk.content !== reviewed.content) throw new Error('Disk content changed since review. Compare or reload again. Your draft is intact.');
          setTabs(tabs => tabs.map(tab => tabKey(tab.path) !== tabKey(original.path) ? tab : { ...tab, document: disk, text: normalizeText(disk.content), baseline: normalizeText(disk.content), editing: tab.editing && !disk.readOnly && disk.lineEnding !== 'mixed', external: undefined, externalDismissed: false, updatedFromDisk: true, syncRevision: (tab.syncRevision || 0) + 1 }));
          setExternalComparison(undefined);
        } catch (cause) { setError(`Could not reload: ${errorMessage(cause)}`); }
      };
      if (tabDirty(original)) setConfirm({ description: `Discard unsaved edits in ${original.path} and replace them with the reviewed disk version? Undo history will reset.`, action: () => void apply() });
      else await apply();
    } catch (cause) { setError(`Could not reload: ${errorMessage(cause)}`); }
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
    if (smart || historyOpen || closeLock.current || !workspace || !document || !editing || !dirty || !writable || saveLock.current || workLock.current || loading || transferLock.current || lease === undefined || naming) return;
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
    try { setNotice(''); await navigator.clipboard.writeText(value); setError(''); setNotice(message); } catch (cause) { throw new Error(`Clipboard unavailable: ${errorMessage(cause)}`); }
  };
  const copyIdentity = () => {
    const context = smartContext.current, currentTabs = tabsRef.current, budget = copyBudgetRef.current;
    const position = editor.current?.position();
    return () => {
      const now = smartContext.current, next = editor.current?.position();
      return now.workspace?.id === context.workspace?.id && now.workspace?.root === context.workspace?.root && now.path === context.path && now.text === context.text && now.lease === context.lease && now.loadedVersion === context.loadedVersion && currentTabs === tabsRef.current && budget === copyBudgetRef.current && position?.anchor === next?.anchor && position?.head === next?.head && !transferLock.current && !closeLock.current;
    };
  };
  const prepareCopy = async (refresh: () => Promise<CopyExport>) => {
    setCopyWarnings([]); setCopyOpen(false); setCopyReview(undefined);
    const valid = copyIdentity();
    const result = await refresh();
    if (!valid()) throw new Error('Copy source changed. Choose the copy action again.');
    if (contextByteSize(result.text) > copyBudgetRef.current) throw new Error('Context exceeds the selected budget including labels and fences. Choose a larger budget, specific files, or selected code. Nothing was truncated.');
    if (result.warnings.some(warning => warning.includes('sanitized source lines'))) { setCopyReview({ result, valid, refresh }); return; }
    setCopyWarnings(result.warnings);
    await copy(result.text, `AI context copied: ${contextByteSize(result.text).toLocaleString()} / ${copyBudgetRef.current.toLocaleString()} bytes; ${result.files} file(s)`);
  };
  const copyRaw = async (value: string, message: string, sourcePath = path) => {
    if (/(^|[/\\])(?:\.env(?:\..*)?|.*\.(?:pem|key|pfx|p12)|id_rsa|id_ed25519|credentials(?:\..*)?)$/i.test(sourcePath) && !window.confirm('This source may contain credentials. Copy its exact raw text to the local clipboard? Other applications may read clipboard contents.')) return;
    setCopyWarnings([]); await copy(value, message);
  };
  const copySlice = (kind: 'selection' | 'lines' | 'section' | 'all', ai = false) => {
    if (!workspace || !document || (kind === 'selection' && !selection.selected) || (markdown && !editing && kind !== 'all')) return;
    const slice = kind === 'all' ? { text: dirty ? diskText(text, document) : document.content, from: 1, to: text.split('\n').length } : editor.current?.slice(kind);
    if (!slice) return;
    void runAction(async () => {
      if (!ai) { await copyRaw(slice.text, 'Code copied'); return; }
      const project = workspace, sourcePath = path, budget = copyBudget;
      await prepareCopy(async () => {
        const result = await editorApi.copy(project, sourcePath, 'copy-slice', budget, slice.text);
        const warnings = result.warnings.map(warning => warning.replace(/sanitized source lines \[([\d,\s]*)\]/, (_, numbers: string) => `sanitized source lines [${numbers.split(',').map(number => Number(number.trim()) + slice.from - 1).join(', ')}]`));
        return { ...result, warnings, text: `Review this source context. Identify changed/new files by project-relative path.\nSource: ${dirty ? 'unsaved editor draft' : 'current editor content'}\n${aiContext(sourcePath, { ...slice, text: result.text })}` };
      });
    });
  };

  const runAction = async (action: () => Promise<void>) => {
    if (closeLock.current || workLock.current || saveLock.current || transferLock.current || loading) return;
    workLock.current = true; setWorking(true); setError(''); setNotice('');
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
  const exportEntry = async (entry: FileEntry, mode: 'file' | 'folder' | 'tree') => {
    if (!workspace) return;
    const project = workspace;
    if (mode === 'tree') {
      const valid = copyIdentity();
      const result = await editorApi.export(project, entry.path, 'tree');
      if (!valid()) throw new Error('Project changed. Copy the tree again.');
      setCopyWarnings(result.warnings); await copy(result.text, `Folder tree copied: ${result.files} file names`); return;
    }
    const budget = copyBudget;
    await prepareCopy(() => editorApi.copy(project, entry.path, mode === 'file' ? 'copy-file' : 'copy-folder', budget));
  };
  const copyMetadata = async (entry: FileEntry, mode: 'name' | 'relative' | 'full') => {
    if (!workspace) return;
    const valid = copyIdentity();
    const result = await editorApi.copy(workspace, entry.path, mode, copyBudget);
    if (!valid()) throw new Error('Project changed. Copy metadata again.');
    setCopyWarnings([]); await copy(result.text, `${mode === 'name' ? 'Name' : mode === 'full' ? 'Full path' : 'Relative path'} copied`);
  };
  const applyName = async (name: string, createParents = false) => {
    if (!workspace || !naming || lease === undefined || workLock.current || saveLock.current) return;
    const operation = naming;
    workLock.current = true; setWorking(true); setNameError('');
    try {
      const next = await editorApi.mutate(workspace, operation.entry.path, operation.action, name, lease, createParents);
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
  const createPastedFiles = async (files: NewFileInput[], parents: boolean): Promise<NewFileOutcome> => {
    if (!workspace || lease === undefined || workLock.current || saveLock.current || transferLock.current || closeLock.current || loading) throw new Error('Editor is busy. Review again.');
    const fresh = files.filter(file => !tabsRef.current.some(tab => tabKey(tab.path) === tabKey(file.path)));
    const size = tabsRef.current.reduce((total, tab) => total + tab.text.length + tab.document.content.length, 0);
    if (tabsRef.current.length + fresh.length > 20 || size + fresh.reduce((total, file) => total + file.content.length * 2, 0) > 16 * 1024 * 1024) throw new Error('Close some tabs before creating files (20 tabs / 16 MiB text budget).');
    workLock.current = true; setWorking(true);
    try {
      const current = smartContext.current;
      if (current.workspace?.id !== workspace.id || current.workspace.root !== workspace.root || current.lease !== lease) throw new Error('Project changed. Reopen the dialog.');
      const outcome = await editorApi.createFiles(workspace, files, lease, false, parents);
      if (smartContext.current.workspace?.id !== workspace.id || smartContext.current.workspace?.root !== workspace.root || smartContext.current.lease !== lease) throw new Error('Editor changed after creation. Inspect the project before retrying.');
      if (outcome.items.some(item => item.created) || outcome.directories.length) {
        const generation = ++epoch.current;
        await Promise.allSettled([...new Set(['', ...expanded])].map(folder => listFolder(folder, workspace, generation)));
        for (const item of outcome.items.filter(item => item.created)) {
          // Preserve drafts and avoid the existing-file save/snapshot pipeline.
          try {
            const existing = tabsRef.current.find(tab => tabKey(tab.path) === tabKey(item.path));
            if (existing) { selectTab(existing.path); continue; }
            const document = await editorApi.read(workspace, item.path);
            const text = normalizeText(document.content);
            const tab: EditorTab = { path: item.path, document, text, baseline: text, editing: false, surfaceOpened: !isMarkdown(item.path), backup: '' };
            const next = [...tabsRef.current, tab]; tabsRef.current = next; setTabs(next); selectTab(item.path);
          } catch (cause) { item.error = [item.error, `Created, but could not open: ${errorMessage(cause)}`].filter(Boolean).join(' '); }
        }
        setNotice(`Created ${outcome.items.filter(item => item.created).length} file(s)${outcome.items.some(item => item.error) ? ' · review reported errors' : ' · opened in Quick Editor'}`);
      }
      return outcome;
    } finally { workLock.current = false; setWorking(false); }
  };
  const menuActions = (): MenuAction[] => {
    // Clipboard creation shares the existing project/window authorization.
    if (menu?.entry) {
      const entry = menu.entry;
      const guarded = (label: string, action: () => Promise<void>): MenuAction => ({ label, title: label.includes('Content') || label.includes('for AI') ? 'Explorer copies saved disk content. Use the editor toolbar to copy unsaved drafts.' : undefined, disabled: entry.blocked, run: () => runAction(action) });
      const name = entry.directory ? 'Folder' : 'File';
      return [
        ...(entry.directory ? ['file', 'folder'].map(action => ({ label: action === 'file' ? 'New File' : 'New Folder', disabled: lease === undefined || entry.blocked, run: () => { setNameError(''); setNaming({ entry, action: action as 'file' | 'folder' }); } })) : [{ label: 'Open', disabled: entry.blocked, run: () => openFile(entry.path) }]),
        ...(entry.directory ? [{ label: 'Paste as New File…', disabled: lease === undefined || entry.blocked, run: () => startPasteNew(entry.path) }] : []),
        { label: 'Rename', disabled: !entry.path || entry.blocked || lease === undefined, run: () => { setNameError(''); setNaming({ entry, action: 'rename' }); } },
        guarded(`Copy ${name} Name`, () => copyMetadata(entry, 'name')),
        guarded('Copy Relative Path', () => copyMetadata(entry, 'relative')),
        guarded('Copy Full Path', () => copyMetadata(entry, 'full')),
        ...(entry.directory ? [guarded('Copy Folder Tree', () => exportEntry(entry, 'tree')), guarded('Copy Folder for AI', () => exportEntry(entry, 'folder'))] : [guarded('Copy Entire File Content', async () => { if (!workspace) return; const valid = copyIdentity(); const result = await editorApi.read(workspace, entry.path); if (!valid()) throw new Error('Project changed. Copy again.'); await copyRaw(result.content, 'Disk file content copied', entry.path); }), guarded('Copy File for AI', () => exportEntry(entry, 'file'))]),
        guarded('Reveal in Windows Explorer', async () => { if (workspace) await editorApi.reveal(workspace, entry.path, entry.directory); }),
      ];
    }
    return [
      { label: 'Smart Replace from Clipboard…', disabled: !workspace || !document || lease === undefined, run: startSmartReplace },
      { label: 'Paste as New File…', disabled: !workspace || lease === undefined, run: () => startPasteNew() },
      ...(['cut', 'copy', 'paste'] as const).map(action => ({ label: action[0].toUpperCase() + action.slice(1), disabled: !document || (action === 'paste' ? !editing : !selection.selected) || (action === 'cut' && !editing), run: async () => { try { if (action === 'copy') { copySlice('selection'); return; } await editor.current?.clipboard(action); } catch (cause) { setError(`Clipboard unavailable: ${errorMessage(cause)}`); } } })),
      { label: 'Select All', disabled: !surfaceOpened || markdown && !editing, run: () => editor.current?.selectAll() },
      { label: 'Copy Selection for AI', disabled: !document || !selection.selected, run: () => copySlice('selection', true) },
      { label: 'Copy Current File', disabled: !document, run: () => copySlice('all') },
      { label: 'Copy Relative Path', disabled: !path, run: () => runAction(() => copyMetadata({ name: path.split('/').pop() || '', path, directory: false, blocked: false }, 'relative')) },
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
    <fieldset className="qe-session-controls" disabled={closing || transferring || working || !!naming || historyOpen || !!smart}><header className="qe-heading">
      <div className="qe-heading-context"><h1><Code2 size={18} />Quick Editor</h1><select aria-label="Editor project" value={workspace?.id || ''} disabled={saving} onChange={event => guard(() => switchProject(projects.find(p => p.id === event.target.value)))}><option value="">Select a project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>{workspace && <ProjectServiceStatus project={workspace} />}</div>
      <div className="qe-heading-actions"><Button tone="quiet" icon={<Search size={14} />} disabled={!workspace || saving} aria-pressed={searchOpen && !collapsed} title="Search project files (Ctrl+Shift+F)" onClick={showProjectSearch}>Search project</Button><ProjectServiceAction project={workspace} /><Button tone="quiet" icon={<PanelBottom size={14} />} aria-pressed={logsOpen} aria-expanded={logsOpen} aria-controls="qe-service-logs" disabled={!workspace} title={logsOpen ? 'Hide project logs' : 'Show project logs'} onClick={() => setLogsOpen(value => !value)}>Logs</Button><Button tone="quiet" icon={<Bot size={14} />} aria-pressed={aiOpen} aria-expanded={aiOpen} aria-controls="qe-ai-panel" title={aiOpen ? 'Hide AI Assistant' : 'Show AI Assistant'} onClick={() => setAiOpen(value => !value)}>AI Assistant</Button><Button tone="quiet" icon={floating ? <PanelBottomClose size={14} /> : <ExternalLink size={14} />} disabled={saving || loading || transferring || working || !!naming} onClick={() => void transfer()} title={floating ? 'Dock in DevFlow' : 'Open Quick Editor in its own window'}>{transferring ? 'Moving…' : floating ? 'Dock' : 'Float'}</Button></div>
    </header><ProjectServiceErrors project={workspace} />
    <div className="qe-session-layout" ref={layout}>
    <div className={`qe-frame ${collapsed ? 'is-collapsed' : ''}`} style={{ '--qe-width': `${width}px`, '--qe-ai-width': `${aiWidth}px` } as React.CSSProperties}>
      {!collapsed && <><aside className="qe-explorer" aria-label="Project files"><div className="qe-explorer-heading"><span>{searchOpen ? 'PROJECT SEARCH' : 'EXPLORER'}</span><button title={searchOpen ? 'Show file explorer' : 'Search project (Ctrl+Shift+F)'} aria-label={searchOpen ? 'Show file explorer' : 'Search project'} aria-pressed={searchOpen} onClick={() => { if (searchOpen) setSearchOpen(false); else showProjectSearch(); }}>{searchOpen ? <FolderOpen size={14} /> : <Search size={14} />}</button><button title="Refresh file tree" aria-label="Refresh file tree" disabled={!workspace || saving} onClick={() => { setFolders({}); setExpanded(new Set([''])); if (workspace) void listFolder('', workspace, ++epoch.current); }}><RefreshCw size={13} /></button><button title="Collapse explorer" aria-label="Collapse explorer" onClick={() => setCollapsed(true)}><PanelLeftClose size={15} /></button></div><div className="qe-root" title={workspace?.root} onContextMenu={event => showMenu(event, rootEntry)}><FolderOpen size={14} /><strong>{workspace?.name || 'No project selected'}</strong></div><div className="qe-tree" hidden={searchOpen} onContextMenu={event => showMenu(event, rootEntry)}>{tree}</div>{workspace && <div className="qe-project-search-host" hidden={!searchOpen}><ProjectSearch key={`${workspace.id}:${workspace.root}`} project={workspace} enabled={visible && searchOpen && !saving && !closing && !transferring && !working && !naming && !smart && !pasting && !historyOpen} focus={searchFocus} dirtyPaths={tabs.filter(tabDirty).map(tab => tab.path)} replace={applyProjectReplacement} open={hit => setPendingLocation({ projectId: workspace.id, path: hit.path, line: hit.line, column: hit.column })} /></div>}{workspace && !searchOpen && <BrainQueue key={workspace.id} projectId={workspace.id} />}<div className="qe-explorer-footer">{!document && workspace ? <label className="qe-folder-budget">Copy for AI budget<select aria-label="Local Copy for AI budget in UTF-8 bytes" title="Local clipboard budget; separate from Assistant attachments and model context" value={copyBudget} onChange={e => setCopyBudget(Number(e.target.value))}><option value="16384">Small · 16 KiB</option><option value="65536">Standard · 64 KiB</option><option value="131072">Large · 128 KiB</option><option value="262144">Very Large · 256 KiB</option><option value="524288">Extended · 512 KiB</option></select></label> : 'Folders load on demand'}</div></aside>
      <div className="qe-divider" role="separator" tabIndex={0} aria-label="Resize file explorer; double-click to reset" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={400} aria-valuenow={width} onDoubleClick={() => setWidth(260)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(180, Math.min(400, value + (event.key === 'ArrowLeft' ? -10 : 10)))); } if (event.key === 'Home') setWidth(260); }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const left = container.current?.getBoundingClientRect().left || 0; const available = container.current?.clientWidth || 600; const aiSpace = aiOpen ? aiWidth : 0; setWidth(Math.max(180, Math.min(400, available - aiSpace - 280, event.clientX - left))); } }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} /></>}
      <div className="qe-reader">
        {tabs.length > 0 && <div className="qe-tabs" role="tablist" aria-label="Open files" onKeyDown={event => {
          if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
          event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
        }}>{tabs.map(tab => <div className={`qe-tab ${tab.path === path ? 'is-active' : ''}`} key={tab.path}><button role="tab" aria-selected={tab.path === path} title={tab.path} onClick={() => selectTab(tab.path)} disabled={saving}><FileIcon name={tab.path} /><span>{tab.path}</span>{tabDirty(tab) && <span aria-label="Unsaved changes">●</span>}{tab.external && <span className="qe-external-marker" aria-label={tab.external === 'missing' ? 'File unavailable on disk' : 'File changed on disk'} title={tab.external === 'missing' ? 'File unavailable on disk' : 'File changed on disk'}>!</span>}{!tab.external && tab.updatedFromDisk && <Check size={12} aria-label="Updated from disk" />}</button><button aria-label={`Close ${tab.path}`} title={`Close ${tab.path}`} disabled={saving || loading} onClick={() => {
          const remove = () => { const result = closeTab(tabsRef.current, path, tab.path); setTabs(result.tabs); setPath(result.active); setLoadedVersion(value => value + 1); };
          if (tabDirty(tab)) setConfirm({ description: `Discard unsaved changes in ${tab.path}?`, action: remove }); else remove();
        }}><X size={13} /></button></div>)}</div>}

        <div className="qe-filebar">{collapsed && <button title="Show explorer" aria-label="Show explorer" onClick={() => setCollapsed(false)}><PanelLeftOpen size={16} /></button>}<div className="qe-filepath" title={path || workspace?.root}>{path ? <><FileIcon name={path} /><span>{path}</span>{dirty && <span className="qe-dirty" aria-label="Unsaved changes" />}</> : <span>Browse · read · copy · edit</span>}</div>{document && <div className="qe-modes" role="group" aria-label="File mode"><button aria-pressed={!editing} className={!editing ? 'is-active' : ''} onClick={() => setEditing(false)}>{markdown ? 'Preview' : 'View'}</button><button aria-pressed={editing} className={editing ? 'is-active' : ''} disabled={!writable || saving} title={!writable ? 'Read-only or mixed line endings' : 'Enable editing'} onClick={() => { setSurfaceOpened(true); setEditing(true); }}><Pencil size={12} />Edit</button></div>}</div>
        {document && <div className="qe-toolbar"><div className="qe-toolbar-group"><HelpLink section="quick-editor" />{markdown && !editing ? <label ref={outlineSearch} className="qe-preview-search"><Search size={14} /><input aria-label="Find Markdown heading" placeholder="Find a heading…" value={previewSearch} onChange={event => { setPreviewSearch(event.target.value); setOutlineOpen(true); }} /></label> : <><button title="Find / replace (Ctrl+F / Ctrl+H)" aria-label="Find / replace" onClick={() => editor.current?.find()}><Search size={15} /></button><button title="Go to line" aria-label="Go to line" onClick={() => editor.current?.goToLine()}><ChevronsUpDown size={15} /></button></>}<button title="Toggle word wrap" disabled={!surfaceOpened} onClick={() => editor.current?.toggleWrap()}>Wrap</button><button ref={outlineTrigger} aria-expanded={outlineOpen} title="Best-effort section outline" onClick={() => setOutlineOpen(!outlineOpen)}><ListTree size={15} /><span>Sections</span></button>{editing && <><button title="Undo (Ctrl+Z)" aria-label="Undo" disabled={saving} onClick={() => editor.current?.undo()}><RotateCcw size={14} /></button><button title="Redo (Ctrl+Y)" aria-label="Redo" disabled={saving} onClick={() => editor.current?.redo()}><RotateCw size={14} /></button></>}</div><div className="qe-toolbar-group"><button aria-haspopup="menu" disabled={saving || loading || lease === undefined} onClick={event => showMenu(event)}>Edit<ChevronDown size={12} /></button><button disabled={saving || loading || lease === undefined} onClick={() => setHistoryOpen(true)}>History</button><details ref={copyMenu} className="qe-copy-menu" open={copyOpen}><summary ref={copyTrigger} aria-expanded={copyOpen} onClick={event => { event.preventDefault(); setCopyOpen(value => !value); }}><Copy size={14} /><span>Copy</span><ChevronDown size={12} /></summary><div role="group" aria-label="Copy actions" onClick={event => { if (event.target instanceof Element) { const button = event.target.closest<HTMLButtonElement>('button'); if (button && !button.disabled) setCopyOpen(false); } }}><button onClick={() => void runAction(() => copyRaw(dirty ? diskText(text, document) : document.content, dirty ? 'Editor draft copied' : 'Current file copied'))}><FileText size={14} />Copy Current File · raw</button><button onClick={() => void runAction(() => copyMetadata({ name: path.split('/').pop() || '', path, directory: false, blocked: false }, 'relative'))}><Clipboard size={14} />Relative path</button><button disabled={(markdown && !editing) || !selection.selected} onClick={() => copySlice('selection')}><Copy size={14} />Copy Selection</button><button disabled={markdown && !editing} onClick={() => copySlice('lines')}><Code2 size={14} />Current line / line range</button><button disabled={markdown && !editing} title="Enclosing foldable section, or surrounding nonblank block" onClick={() => copySlice('section')}><Braces size={14} />Current code section</button></div></details><select aria-label="Copy for AI scope" value={copyScope} onChange={e => setCopyScope(e.target.value as typeof copyScope)}><option value="selection" disabled={!selection.selected}>Selected Code</option><option value="section" disabled={markdown && !editing}>Current Function / Section</option><option value="all">Current File</option></select><select aria-label="Local Copy for AI budget in UTF-8 bytes" title="Local clipboard budget; separate from Assistant attachments and model context" value={copyBudget} onChange={e => setCopyBudget(Number(e.target.value))}><option value="16384">Small · 16 KiB</option><option value="65536">Standard · 64 KiB</option><option value="131072">Large · 128 KiB</option><option value="262144">Very Large · 256 KiB</option><option value="524288">Extended · 512 KiB</option></select><button className="qe-ai" disabled={working || saving || loading || (copyScope === 'selection' && !selection.selected) || (markdown && !editing && copyScope !== 'all')} title="Prepare the chosen source for local clipboard sharing; never sends a provider request" onClick={() => copySlice(copyScope, true)}><Sparkles size={14} /><span>Copy for AI</span></button>{editing && <button className="qe-save" title="Save (Ctrl+S)" disabled={!dirty || saving || !writable || lease === undefined} onClick={() => void save()}>{saving ? <Loader2 size={14} className="qe-spin" /> : <Save size={14} />}<span>Save</span></button>}<button title="Reload disk version" aria-label="Reload disk version" disabled={saving || loading} onClick={() => void reloadExternal()}><RefreshCw size={14} /></button></div></div>}
        {outlineOpen && document && <div ref={outline} className="qe-outline" aria-label="Section navigation"><div><span>SECTIONS · BEST EFFORT</span><button aria-label="Close sections" onClick={() => setOutlineOpen(false)}><X size={13} /></button></div>{sections.filter(s => s.label.toLowerCase().includes(previewSearch.toLowerCase())).map(s => <button key={s.line} onClick={() => jump(s.line, sections.indexOf(s))}><span>{s.label}</span><small>{s.line}</small></button>)}{!sections.length && <p>No named sections found. Use search or go to line.</p>}</div>}
        <OperationNotice message={error} dismiss={() => setError('')} />
        {active?.external && <div className="qe-external-notice" role="status">
          <span>{active.external === 'missing' ? 'File missing or unavailable on disk. Your text is preserved.' : dirty ? 'External changes detected — review before saving.' : 'File changed on disk.'}{active.externalDismissed && ' Draft kept; disk conflict protection remains active.'}</span>
          {!active.externalDismissed ? <>
            <button className="button" onClick={() => void compareExternal()}>Compare Changes</button>
            <button className="button" onClick={() => void reloadExternal()}>{active.external === 'missing' ? 'Retry Reload' : 'Reload from Disk'}</button>
            <button className="button" onClick={() => { updateTab({ externalDismissed: true }); setExternalComparison(undefined); }}>{dirty ? 'Keep My Draft' : 'Dismiss'}</button>
          </> : <button className="button" onClick={() => updateTab({ externalDismissed: false })}>Review</button>}
        </div>}
        {!active?.external && active?.updatedFromDisk && <div className="qe-disk-feedback" role="status" title="Replacing editor text with disk content resets undo history.">Updated from disk<button aria-label="Dismiss disk update" onClick={() => updateTab({ updatedFromDisk: false })}><X size={12} /></button></div>}
        {externalComparison?.path === path && <section className="qe-external-comparison" aria-label="External file comparison">
          <header><span>Local comparison · disk read on Compare; no merge</span><button className="button" onClick={() => void compareExternal()}>Refresh comparison</button><button className="button" onClick={() => setExternalComparison(undefined)}>Close comparison</button></header>
          <div className="qe-history-content is-comparing"><section><h3>Current editor draft</h3><pre tabIndex={0} aria-label="Current editor draft">{text}</pre></section><section><h3>Disk version · read on Compare</h3><pre tabIndex={0} aria-label="Compared disk version">{externalComparison.disk}</pre></section></div>
        </section>}
        {loading && document && <div className="qe-opening" role="status"><Loader2 className="qe-spin" size={13} />Opening file…</div>}
        {loading && !document ? <div className="qe-empty" role="status"><Loader2 className="qe-spin" size={24} /><strong>Opening file…</strong><span>Reading a single file from your project.</span></div> : !document ? <div className="qe-empty"><span className="qe-empty-symbol"><Code2 size={27} strokeWidth={1.4} /></span><strong>A little space for focused work.</strong><span>Choose a file to read, copy context for AI,<br />or make a careful edit.</span><div><kbd>View first</kbd><ChevronRight size={12} /><kbd>Edit when ready</kbd></div></div> : <>
          {markdown && !editing && <div className="qe-preview" ref={preview}><Preview text={text} copy={(value, message) => void runAction(() => copyRaw(value, message))} /></div>}
          {surfaceOpened && <div className="qe-surface" hidden={markdown && !editing}><Suspense fallback={<div className="qe-empty" role="status"><Loader2 className="qe-spin" size={20} />Loading editor…</div>}><EditorSurface key={`${workspace?.id}:${path}:${loadedVersion}`} ref={editor} syncRevision={active?.syncRevision} position={active?.position} content={text} path={path} line={logJump && logJump.projectId === workspace?.id && tabKey(logJump.path) === tabKey(path) ? logJump.line : undefined} column={logJump && logJump.projectId === workspace?.id && tabKey(logJump.path) === tabKey(path) ? logJump.column : undefined} editing={editing && !closing && !saving && !loading && !transferring && !working && !naming && !smart && !pasting} onChange={setText} onSelection={(from, to, selected) => setSelection({ from, to, selected })} onSave={() => void latestSave.current()} onContextMenu={event => showMenu(event)} /></Suspense></div>}
        </>}
        <footer className="qe-status"><span role="status">{notice ? <><Check size={12} />{notice}</> : <>{dirty ? '● Unsaved changes' : editing ? 'Editing' : markdown && document ? 'Markdown preview' : 'Read-only view'}{document && <> · {extension(path).toUpperCase() || 'TEXT'}</>}</>}</span><span>{document && <>{markdown && !editing ? `${text.split('\n').length} lines` : `Ln ${selection.from}${selection.to !== selection.from ? `–${selection.to}` : ''}`}<span className="qe-status-detail"> · UTF-8{document.content.startsWith('\uFEFF') ? ' BOM' : ''} · {document.lineEnding}</span></>}{backup && <span title="Previous disk version stored in DevFlow local file history" className="qe-recovery"> · Local snapshot saved</span>}</span></footer>
      </div>
      {<>
        <div hidden={!aiOpen} className="qe-divider qe-ai-divider" role="separator" tabIndex={0} aria-label="Resize AI assistant panel; double-click to reset" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={550} aria-valuenow={aiWidth} onDoubleClick={() => setAiWidth(340)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setAiWidth(value => Math.max(260, Math.min(550, value + (event.key === 'ArrowLeft' ? 10 : -10)))); } if (event.key === 'Home') setAiWidth(340); }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const rect = container.current?.getBoundingClientRect(); const right = rect?.right || window.innerWidth; const available = container.current?.clientWidth || 800; const explorerSpace = collapsed ? 0 : width; setAiWidth(clampAiWidth(right - event.clientX, available, explorerSpace)); } }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
        <div style={{ display: aiOpen ? 'contents' : 'none' }}><AiAssistantPanel onFlushReady={flush => { flushAi.current = flush; }} initialMessages={aiMessages.current} initialReviewed={aiReviewed.current} onMessagesChange={value => { aiMessages.current = value; }} onStreamingChange={value => { aiStreaming.current = value; }} onReviewedChange={value => { aiReviewed.current = value; }} key={`${workspace?.id}:${workspace?.root}:${lease}`} projectRoot={workspace?.root || ''} editorLease={lease} onOpenReference={(path, line) => { if (workspace) setPendingLocation({ projectId: workspace.id, path, line }); }} onClose={() => setAiOpen(false)} projectId={workspace?.id || ''} attachments={aiAttachments} onAttachmentsChange={updateAiAttachments} onAttachCurrentFile={attachCurrentFile} canAttachCurrentFile={!!document && !!path && !loading && !saving && !working} onAttachSelectedCode={attachSelectedCode} canAttachSelectedCode={!!document && selection.selected && surfaceOpened && !loading && !saving && !working} onAttachSelectedLogs={() => attachLogs(checkedLogEntries, `Selected logs · ${checkedLogEntries.length} entries`)} canAttachSelectedLogs={checkedLogEntries.some(entry => entry.projectId === workspace?.id)} onAttachProjectContext={attachProjectContext} canAttachProjectContext={!!workspace && !loading && !working} provider={aiProvider} onProviderChange={setAiProvider} model={aiModel} onModelChange={setAiModel} draft={aiDraft} onDraftChange={setAiDraft} onCopyNotice={msg => setNotice(msg)} /></div>
      </>}
    </div>
    {pendingLogs.length > 0 && !pendingLogs.includes(workspace?.id || '') && <p role="status">Logs are waiting to dock. Select their project in Quick Editor; unsaved files remain protected.</p>}
    {logsOpen && workspace && <>
      <div hidden={logsCollapsed} className="qe-logs-divider" title="Drag to resize logs; double-click to reset" role="separator" tabIndex={0} aria-label="Resize logs panel" aria-orientation="horizontal" aria-valuemin={180} aria-valuemax={Math.max(180, Math.floor((layout.current?.clientHeight || 600) * .65))} aria-valuenow={logsHeight}
        onDoubleClick={() => setLogsHeight(330)} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const max = Math.max(180, Math.floor((layout.current?.clientHeight || 600) * .65)); setLogsHeight(value => event.key === 'Home' ? 180 : event.key === 'End' ? max : Math.max(180, Math.min(max, value + (event.key === 'ArrowUp' ? 20 : -20)))); } }}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const rect = layout.current?.getBoundingClientRect(); if (rect) setLogsHeight(Math.max(180, Math.min(Math.floor(rect.height * .65), rect.bottom - event.clientY))); } }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
      <section id="qe-service-logs" className={`qe-bottom-logs ${logsCollapsed ? 'is-collapsed' : ''}`} aria-label="Project logs" style={{ '--logs-height': `${logsHeight}px` } as React.CSSProperties} onContextMenu={event => event.stopPropagation()}>
        <LogsHeader project={workspace} onFloat={() => void floatLogs(workspace).then(() => { setLogsOpen(false); setError(''); }).catch(cause => setError(errorMessage(cause)))} collapsed={logsCollapsed} onCollapse={() => setLogsCollapsed(value => !value)} onHide={() => setLogsOpen(false)} />
        <div className="qe-logs-content" hidden={logsCollapsed}>{visible && <ProjectLogs key={workspace.id} project={workspace} onAttachLogs={attachLogs} onCheckedLogsChange={setCheckedLogEntries} />}</div>
      </section>
    </>}
    </div>
    </fieldset>
    {pasting && workspace && lease !== undefined && <PasteAsNewFile project={workspace} blocks={pasting.blocks} folder={pasting.folder} lease={lease} create={createPastedFiles} open={openFile} close={() => setPasting(undefined)} />}
    {smart && workspace && <SmartReplace project={workspace} blocks={smart.blocks} currentPath={path} selection={smart.selection} openPaths={tabs.map(tab => tab.path)} load={loadSmartTarget} search={searchSmartTargets} apply={applySmartReplace} close={() => setSmart(undefined)} />}
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
    {copyReview && <CopyReview result={copyReview.result} budget={copyBudget} busy={working} cancel={() => setCopyReview(undefined)} approve={() => void runAction(async () => {
      const review = copyReview;
      if (!review.valid()) { setCopyReview(undefined); throw new Error('Copy source changed. Prepare it again.'); }
      const fresh = await review.refresh();
      if (!review.valid() || fresh.text !== review.result.text || JSON.stringify(fresh.warnings) !== JSON.stringify(review.result.warnings)) { setCopyReview(undefined); throw new Error('Source changed since review. Prepare the copy again.'); }
      await copy(review.result.text, `Sanitized context copied: ${contextByteSize(review.result.text).toLocaleString()} / ${copyBudget.toLocaleString()} bytes`);
      setCopyWarnings(review.result.warnings); setCopyReview(undefined);
    })} />}
    {!!copyWarnings.length && <div className="qe-copy-warning" role="status"><strong>Copy details</strong>{copyWarnings.map(warning => <div key={warning}>{warning}</div>)}<button onClick={() => setCopyWarnings([])}>Dismiss</button></div>}
    {menu && <EditorContextMenu x={menu.x} y={menu.y} actions={menuActions()} close={() => setMenu(undefined)} />}
    {naming && <EditorNameDialog destination={naming.entry.path} title={naming.action === 'rename' ? `Rename ${naming.entry.name}` : naming.action === 'file' ? 'New File' : 'New Folder'} initial={naming.action === 'rename' ? naming.entry.name : ''} busy={working} error={nameError} submit={(name, createParents) => void applyName(name, createParents)} close={() => { setNaming(undefined); setNameError(''); }} />}
    {confirm && createPortal(<ConfirmDialog title="Unsaved file changes" description={confirm.description} confirmText="Discard and continue" destructive onCancel={() => { confirm.cancel?.(); setConfirm(undefined); }} onConfirm={() => { const action = confirm.action; setConfirm(undefined); action(); }} />, window.document.body)}
  </section>;
}
