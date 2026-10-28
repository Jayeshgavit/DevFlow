import { invoke } from '@tauri-apps/api/core';
import { loadHistory, saveHistory, type History } from './chat-history';
import { redactForSharing } from './log-utils';
import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  AlertCircle,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Code2,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  FileText,
  Key,
  RefreshCw,
  Send,
  Shield,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Plus,
  X,
  FolderTree,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  aiApi,
  type AiModelInfo,
  type AiProvider,
  type CredentialStatus,
  type TestConnectionResult,
  type ModelCheckResult,
} from './ai-api';
import './ai-assistant-panel.css';
import AiFilePicker from './AiFilePicker';
import AiCode, { AiCopyButton, AiCodeBlock } from './AiCode';
import { contextByteSize, attachmentsForProject, formatAttachments, safeAiContext, sanitizeDiagnosticPaths, type AiAttachment } from './ai-context';

type AssistantMode = 'chat' | 'research' | 'web';

export type { AiProvider };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  status?: 'partial' | 'complete' | 'cancelled' | 'error';
  content: string;
  timestamp: number;
  references?: { path: string; line?: number | null }[];
}

export interface AiAssistantPanelProps {
  projectId: string;
  projectRoot: string;
  editorLease?: number;
  onOpenReference: (path: string, line: number) => void;
  attachments: AiAttachment[];
  onAttachmentsChange: (attachments: AiAttachment[]) => void;
  onAttachCurrentFile: () => void;
  canAttachCurrentFile: boolean;
  onAttachSelectedCode: () => void;
  canAttachSelectedCode: boolean;
  onAttachSelectedLogs: () => void;
  canAttachSelectedLogs: boolean;
  onAttachProjectContext: () => void;
  canAttachProjectContext: boolean;
  onClose: () => void;
  provider: AiProvider;
  onProviderChange: (provider: AiProvider) => void;
  model: string;
  onModelChange: (model: string) => void;
  draft: string;
  onDraftChange: (draft: string) => void;
  onCopyNotice?: (message: string) => void;
  initialMessages?: ChatMessage[];
  initialReviewed?: string;
  onFlushReady?: (flush: () => Promise<void>) => void;
  onMessagesChange?: (messages: ChatMessage[]) => void;
  onStreamingChange?: (streaming: boolean) => void;
  onReviewedChange?: (key: string) => void;
}

export const AI_SUGGESTIONS = [
  {
    kind: 'Explain code' as const,
    label: 'Explain code',
    icon: FileCode2,
    prompt: 'Explain what this code does, how it works, and its key logic:',
  },
  {
    kind: 'Debug error' as const,
    label: 'Debug error',
    icon: Terminal,
    prompt: 'Help me debug this error and identify possible causes and solutions:',
  },
  {
    kind: 'Review selected code' as const,
    label: 'Review selected code',
    icon: Code2,
    prompt: 'Review this code for edge cases, performance, security, and improvements:',
  },
];

export function clampAiWidth(requestedWidth: number, containerWidth: number, explorerWidth = 0): number {
  const minEditorWidth = 280;
  const maxAllowed = Math.max(260, containerWidth - explorerWidth - minEditorWidth);
  return Math.max(260, Math.min(550, Math.min(maxAllowed, requestedWidth)));
}

const ConversationMessage = memo(function ConversationMessage({ msg, isGeneratingThis, onOpenReference }: {
  msg: ChatMessage;
  isGeneratingThis: boolean;
  onOpenReference: AiAssistantPanelProps['onOpenReference'];
}) {
  return (
    <div
      key={msg.id}
      className={`qe-ai-message is-${msg.role}`}
      role="article"
      aria-label={`${msg.role === 'user' ? 'User' : 'Assistant'} message`}
    >
      <div className="qe-ai-msg-header">
        <span className="qe-ai-msg-role">
          {msg.role === 'user' ? 'You' : 'DevFlow AI'}
        </span>
      </div>
      <div className="qe-ai-bubble">
        {msg.role === 'assistant' ? (
          <article className="qe-ai-markdown">
            {msg.content ? (
              <Markdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                urlTransform={url =>
                  /^(project:\/\/|https?:\/\/|mailto:|#[^\s]*)/i.test(url) ? url : ''
                }
                components={{
                  code: AiCode,
                  img: ({ alt }) => <span>{alt || "Image omitted"}</span>,
                  table: ({ children }) => <div className="qe-ai-table-scroll"><table>{children}</table></div>,
                  a: ({ href, children }) => {
                    if (href?.startsWith('project://')) {
                      let path = ''; let line = 1;
                      try {
                        const match = /^project:\/\/(.+?)(?:#L(\d+))?$/.exec(href);
                        if (match) { path = decodeURIComponent(match[1]); line = Number(match[2] || 1); }
                      } catch { /* Invalid source reference remains plain text. */ }
                      const verified = msg.references?.some(ref => ref.path === path && (ref.line == null || ref.line === line));
                      return verified ? <button type="button" className="qe-ai-source-link" onClick={() => onOpenReference(path, line)}>{children}</button> : <span>{children}</span>;
                    }
                    return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
                  },
                  pre: AiCodeBlock,
                }}
              >
                {msg.content}
              </Markdown>
            ) : (
              <span className="qe-ai-thinking">{isGeneratingThis ? 'Thinking…' : msg.status === 'cancelled' ? 'Generation stopped' : msg.status === 'error' ? 'Response failed' : 'No response content'}</span>
            )}
            {msg.status === 'partial' && !isGeneratingThis && <small>Partial response · interrupted</small>}
            {msg.content && msg.status === 'cancelled' && <small className="qe-ai-response-status">Generation stopped</small>}
            {msg.content && msg.status === 'error' && <small className="qe-ai-response-status">Response failed</small>}
            {isGeneratingThis && msg.content && <span className="qe-ai-stream-status" role="status"><span className="qe-ai-cursor" aria-hidden="true" /> Generating…</span>}
          </article>
        ) : (
          <div className="qe-ai-user-text">{msg.content}</div>
        )}
      </div>
      {msg.content.trim() && !isGeneratingThis && <footer className="qe-ai-message-actions">
        <AiCopyButton text={msg.content} label={msg.role === 'assistant' ? 'Copy message' : 'Copy'} className="qe-ai-msg-copy-btn" />
      </footer>}
    </div>
  );
});

export default function AiAssistantPanel({
  projectId,
  projectRoot,
  editorLease,
  onOpenReference,
  attachments,
  onAttachmentsChange,
  onAttachCurrentFile,
  canAttachCurrentFile,
  onAttachSelectedCode,
  canAttachSelectedCode,
  onAttachSelectedLogs,
  canAttachSelectedLogs,
  onAttachProjectContext,
  canAttachProjectContext,
  onClose,
  provider,
  onProviderChange,
  model,
  onModelChange,
  draft,
  onDraftChange,
  initialMessages = [], initialReviewed = '', onFlushReady, onMessagesChange, onStreamingChange, onReviewedChange,
}: AiAssistantPanelProps) {
  const [configExpanded, setConfigExpanded] = useState(() => { try { return localStorage.getItem('devflow-ai-config-expanded') === 'true'; } catch { return false; } });
  const [mode, setMode] = useState<AssistantMode>(() => {
    try { const saved = localStorage.getItem('devflow-ai-mode'); return saved === 'research' || saved === 'web' ? saved : 'chat'; }
    catch { return 'chat'; }
  });
  const researchEnabled = mode === 'research';
  const [sanitizedPreview, setSanitizedPreview] = useState('');
  useEffect(() => { try { localStorage.setItem('devflow-ai-mode', mode); } catch { /* Session mode remains usable. */ } }, [mode]);
  const [researchToken, setResearchToken] = useState<string>();
  const [researchError, setResearchError] = useState('');
  const [activity, setActivity] = useState('');
  useEffect(() => {
    if (!projectId || editorLease === undefined || !researchEnabled) return;
    let disposed = false;
    let token: string | undefined;
    setResearchError('');
    void aiApi.researchContext(projectId, projectRoot, editorLease).then(value => {
      token = value;
      if (disposed) void aiApi.clearResearchContext(value);
      else setResearchToken(value);
    }).catch(cause => { if (!disposed) setResearchError(String(cause)); });
    return () => { disposed = true; setResearchToken(undefined); if (token) void aiApi.clearResearchContext(token); };
  }, [projectId, projectRoot, editorLease, researchEnabled]);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const historyRef = useRef<History>({ revision: 0, location: '', chats: [] });
  const [historyReady, setHistoryReady] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historyAction = useRef(false);
  const panelLifetime = useRef(0);
  useEffect(() => { panelLifetime.current++; return () => { panelLifetime.current++; }; }, [projectId, projectRoot]);
  const chatId = useRef<string>(crypto.randomUUID());
  const savingHistory = useRef(Promise.resolve());
  const pendingHistory = useRef<(() => void)>();
  const saveFailure = useRef('');
  const flushHistory = async () => { pendingHistory.current?.(); pendingHistory.current = undefined; await savingHistory.current; if (saveFailure.current) throw new Error(saveFailure.current); };
  useEffect(() => { onFlushReady?.(flushHistory); }, []);
  useEffect(() => {
    let disposed = false;
    if (!projectId) return;
    void loadHistory(projectId).then(history => {
      if (disposed) return;
      historyRef.current = history;
      const last = history.chats[0];
      if (last && !initialMessages.length) {
        followLatest.current = true; chatId.current = last.id; setMessages(last.messages); onDraftChange(last.draft);
        onProviderChange(last.provider); if (last.provider === 'nvidia-nim') setNimModel(last.model); else onModelChange(last.model);
      } else if (initialMessages.length) {
        const match = history.chats.find(chat => chat.messages[0]?.id === initialMessages[0]?.id);
        if (match) chatId.current = match.id;
      }
      setHistoryReady(true);
    }).catch(cause => { if (!disposed) setHistoryError(String(cause)); });
    return () => { disposed = true; };
  }, [projectId]);
  useEffect(() => {
    if (historyAction.current || !historyReady || editorLease === undefined || (!messages.length && !draft)) return;
    const id = chatId.current;
    const snapshot = { id, title: historyRef.current.chats.find(c => c.id === id)?.title || redactForSharing(messages.find(m => m.role === 'user')?.content.slice(0, 80) || 'New conversation'), provider, model: provider === 'nvidia-nim' ? localStorage.getItem('devflow-nim-model') || '' : model, draft: redactForSharing(draft), updated: Date.now(), messages: messages.map(({ id, role, content, timestamp, status }) => ({ id, role, content: redactForSharing(content), timestamp, status })) };
    const persist = () => {
      pendingHistory.current = undefined;
      savingHistory.current = savingHistory.current.then(async () => {
        const history = historyRef.current;
        const next = { revision: history.revision, location: history.location, chats: [{ ...snapshot, title: history.chats.find(c => c.id === id)?.title || snapshot.title }, ...history.chats.filter(c => c.id !== id)] };
        try { next.revision = await saveHistory(projectId, editorLease, next); historyRef.current = next; setHistoryVersion(v => v + 1); setHistoryError(''); saveFailure.current = ''; }
        catch (cause) { saveFailure.current = String(cause); setHistoryError(String(cause)); }
      });
    };
    pendingHistory.current = persist;
    const timer = setTimeout(() => { if (pendingHistory.current === persist) persist(); }, 400);
    return () => clearTimeout(timer);
  }, [messages, draft, provider, model, historyReady, editorLease]);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [reviewedAttachmentKey, setReviewedAttachmentKey] = useState(initialReviewed);
  // Consent follows exact snapshot contents, even if a restored attachment
  // retains its ID. Changing a label/project/content requires fresh review.
  const attachmentKey = attachments.length ? JSON.stringify(attachments.map(({ id, projectId, kind, label, content, unsaved }) => ({ id, projectId, kind, label, content, unsaved }))) : '';
  const previousAttachmentKey = useRef(attachmentKey);
  useEffect(() => { if (previousAttachmentKey.current !== attachmentKey) setReviewedAttachmentKey(''); previousAttachmentKey.current = attachmentKey; }, [attachmentKey, projectId]);
  useEffect(() => { onMessagesChange?.(messages); }, [messages]);
  useEffect(() => { onStreamingChange?.(isStreaming); }, [isStreaming]);
  useEffect(() => { onReviewedChange?.(reviewedAttachmentKey); }, [reviewedAttachmentKey]);
  useEffect(() => {
    const compatible = attachmentsForProject(attachments, projectId);
    if (compatible.length !== attachments.length) onAttachmentsChange(compatible);
  }, [attachments, projectId, onAttachmentsChange]);

  // Credentials & Provider status
  const [credStatus, setCredStatus] = useState<CredentialStatus | null>(null);
  const [isKeyModalOpen, setIsKeyModalOpen] = useState<boolean>(false);
  const [inputKey, setInputKey] = useState<string>('');
  const [showKeyPlaintext, setShowKeyPlaintext] = useState<boolean>(false);
  const [isTesting, setIsTesting] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [isSavingKey, setIsSavingKey] = useState<boolean>(false);
  const [keyActionNotice, setKeyActionNotice] = useState<string | null>(null);

  // Models
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState<boolean>(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [nimModel, setNimModelState] = useState(() => { try { return localStorage.getItem('devflow-nim-model') || ''; } catch { return ''; } });
  const setNimModel = (value: string) => { setNimModelState(value); try { localStorage.setItem('devflow-nim-model', value); } catch { /* Session selection remains usable. */ } };
  const [catalogReady, setCatalogReady] = useState(false);
  const [freeOnly, setFreeOnly] = useState(false);
  const [responseTokens, setResponseTokens] = useState(1024);
  const automaticNim = models.find(item => item.is_default);
  const nimAutomaticModel = automaticNim?.id || '';
  const savedModel = provider === 'nvidia-nim' ? nimModel : model;
  const preferredModel = provider === 'nvidia-nim' ? automaticNim?.id || '' : '';
  const effectiveModel = savedModel && models.some(item => item.id === savedModel) ? savedModel : preferredModel;
  const selectedModel = models.find(item => item.id === effectiveModel);
  const visibleModels = models.filter(item => (!freeOnly || item.is_free === true) && `${item.name} ${item.id}`.toLowerCase().includes(modelSearch.toLowerCase()));
  const [modelChecks, setModelChecks] = useState<Record<string, ModelCheckResult & { checkedAt: string }>>({});
  const [isModelChecking, setIsModelChecking] = useState(false);
  const [checkingModel, setCheckingModel] = useState('');
  const checkRunRef = useRef<{ cancelled: boolean } | null>(null);
  const checkKey = (id: string) => `${provider}:${researchEnabled ? 'research' : 'chat'}:${id}`;
  const selectedCheck = selectedModel ? modelChecks[checkKey(effectiveModel)] : undefined;
  const checkedModels = Object.entries(modelChecks).filter(([key, check]) => key.startsWith(checkKey('')) && models.some(item => item.id === check.model))
    .map(([, check]) => check).sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working'));
  const modelOption = (id: string, name: string) => {
    const check = modelChecks[checkKey(id)];
    const info = models.find(item => item.id === id);
    const capability = info?.supports_tools === false && researchEnabled ? 'No tools advertised' : undefined;
    const status = check?.status === 'working' ? '✓ Working' : check?.status === 'unavailable' ? '✕ Failed check' : check ? '○ Inconclusive' : capability || '○ Untested';
    return `${status} · ${name}${info?.is_free === true ? ' · Free' : info?.is_free === false ? ' · Paid' : ''}`;
  };
  useEffect(() => () => {
    const run = checkRunRef.current;
    if (run) { run.cancelled = true; void aiApi.stopChat('model-check').catch(() => {}); }
  }, [provider, researchEnabled]);

  const checkModels = async (batch: boolean) => {
    if (checkRunRef.current || isStreaming || isKeyModalOpen || isSavingKey || isTesting || !credStatus?.has_key || !catalogReady) return;
    const ids = batch
      ? [...new Set([effectiveModel, ...visibleModels.map(item => item.id)])].filter(id => id && visibleModels.some(item => item.id === id) && !modelChecks[checkKey(id)]).slice(0, 5)
      : effectiveModel ? [effectiveModel] : [];
    if (!ids.length) return;
    const run = { cancelled: false };
    checkRunRef.current = run;
    setIsModelChecking(true);
    setModelsError(null);
    try {
      for (const id of ids) {
        if (run.cancelled) break;
        setCheckingModel(id);
        const key = checkKey(id);
        const info = models.find(item => item.id === id);
        const check: ModelCheckResult = researchEnabled && info?.supports_tools === false
          ? { model: id, status: 'unavailable', message: 'Provider catalog does not advertise tool calling for this model. No inference request was sent; disable Research for chat.' }
          : await aiApi.checkModel(provider, id, researchEnabled);
        if (run.cancelled) break;
        setModelChecks(previous => ({ ...previous, [key]: { ...check, checkedAt: new Date().toLocaleString() } }));
        // Avoid spending more credits while the account/network state is inconclusive.
        if (check.stop_batch ?? check.status === 'unknown') break;
      }
    } catch (cause) {
      if (!run.cancelled) setModelsError(typeof cause === 'string' ? cause : 'Model check failed. Try again.');
    } finally {
      if (checkRunRef.current === run) {
        checkRunRef.current = null;
        setIsModelChecking(false);
        setCheckingModel('');
      }
    }
  };
  const stopModelChecks = () => {
    if (checkRunRef.current) checkRunRef.current.cancelled = true;
    void aiApi.stopChat('model-check').catch(() => setModelsError('Could not confirm cancellation; the check will time out automatically.'));
  };

  const providerRef = useRef(provider);
  const modelRef = useRef(model);
  const catalogRequestRef = useRef(0);
  providerRef.current = provider;
  modelRef.current = model;

  const referenceHandler = useRef(onOpenReference);
  useLayoutEffect(() => { referenceHandler.current = onOpenReference; }, [onOpenReference]);
  const openReference = useCallback((path: string, line: number) => referenceHandler.current(path, line), []);
  const attachMenuRef = useRef<HTMLDetailsElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const syncScrollRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const area = messageAreaRef.current;
    const content = messageContentRef.current;
    if (!area || !content) return;
    let frame = 0;
    let savedTop = area.scrollTop;
    let anchor: { element: HTMLElement; offset: number } | undefined;
    let appliedTop = area.scrollTop;
    const remember = () => {
      savedTop = area.scrollTop;
      const top = area.getBoundingClientRect().top;
      const element = Array.from(content.querySelectorAll<HTMLElement>('.qe-ai-user-text, .qe-ai-markdown p, .qe-ai-markdown pre, .qe-ai-markdown :is(h1,h2,h3,h4,h5,h6), .qe-ai-markdown li:not(:has(p,ul,ol))'))
        .find(message => message.getBoundingClientRect().bottom > top);
      anchor = element ? { element, offset: element.getBoundingClientRect().top - top } : undefined;
    };
    const sync = () => {
      // display:none during panel collapse must not overwrite the reading bookmark.
      if (!area.clientHeight || !area.clientWidth) return;
      if (followLatest.current) area.scrollTop = area.scrollHeight;
      else if (anchor?.element.isConnected) {
        area.scrollTop += anchor.element.getBoundingClientRect().top - area.getBoundingClientRect().top - anchor.offset;
      } else area.scrollTop = savedTop;
      appliedTop = area.scrollTop;
      setAwayFromLatest(area.scrollHeight - area.clientHeight - area.scrollTop > 64);
    };
    syncScrollRef.current = sync;
    const onScroll = () => {
      if (!area.clientHeight || area.scrollTop === appliedTop) return;
      followLatest.current = area.scrollHeight - area.clientHeight - area.scrollTop <= 64;
      appliedTop = area.scrollTop;
      remember();
      setAwayFromLatest(!followLatest.current);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    });
    observer.observe(area);
    observer.observe(content);
    area.addEventListener('scroll', onScroll, { passive: true });
    sync();
    remember();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      area.removeEventListener('scroll', onScroll);
      syncScrollRef.current = () => {};
    };
  }, [projectId]);
  useLayoutEffect(() => { syncScrollRef.current(); }, [messages]);
  const scrollMessages = () => {
    followLatest.current = true;
    syncScrollRef.current();
    messageAreaRef.current?.focus({ preventScroll: true });
  };

  // Load credential status for current provider
  const loadCredentials = useCallback(async (prov: AiProvider) => {
    try {
      const status = await aiApi.getCredentialStatus(prov);
      if (providerRef.current === prov) setCredStatus(status);
      return status.has_key;
    } catch {
      if (providerRef.current === prov) setCredStatus({ provider: prov, has_key: false });
      return false;
    }
  }, []);

  // Ignore late catalog responses after a provider switch or newer refresh.
  const loadModels = useCallback(async (prov: AiProvider) => {
    const request = ++catalogRequestRef.current;
    setModelsLoading(true);
    setCatalogReady(false);
    setModelsError(null);
    try {
      const list = await aiApi.listModels(prov);
      if (request !== catalogRequestRef.current || providerRef.current !== prov) return;
      setModels(list);
      const preferred = prov === 'nvidia-nim' ? list.find(item => item.id === 'nvidia/nemotron-3.5-bolt-e4b' && item.supports_tools !== undefined) : undefined;
      if (prov === 'nvidia-nim' && nimModel && !list.some(item => item.id === nimModel) && preferred) setNimModel(preferred.id);
      if (prov === 'nvidia-nim' && !nimModel && preferred) setNimModel(preferred.id);
      setCatalogReady(true);
      if (prov === 'openrouter' && (!list.some(item => item.id === modelRef.current) || !modelRef.current)) {
        const candidate = list.find(item => item.is_free === true && item.supports_tools === true && /cod|qwen|deepseek/i.test(`${item.name} ${item.id}`));
        onModelChange(candidate?.id || '');
      }
    } catch (cause) {
      if (request === catalogRequestRef.current && providerRef.current === prov) setModelsError(typeof cause === 'string' ? cause : 'Failed to retrieve models');
    } finally {
      if (request === catalogRequestRef.current) setModelsLoading(false);
    }
  }, [onModelChange, nimModel]);

  useEffect(() => {
    let disposed = false;
    catalogRequestRef.current++;
    setModels([]);
    setCatalogReady(false);
    setModelsLoading(false);
    setModelsError(null);
    setCredStatus(null);
    setShowModelPicker(true);
    setTestResult(null);
    void loadCredentials(provider).then(hasKey => { if (!disposed && hasKey && providerRef.current === provider) void loadModels(provider); });
    return () => { disposed = true; catalogRequestRef.current++; };
  }, [provider, loadCredentials, loadModels]);

  // Unlisten on unmount and stop active streaming
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (activeRequestRef.current) {
        void aiApi.stopChat(activeRequestRef.current);
      }
    };
  }, []);

  const handleClearChat = (preserve = true) => {
    if (historyAction.current) return;
    if (preserve) pendingHistory.current?.(); else pendingHistory.current = undefined;
    chatId.current = crypto.randomUUID();
    const requestId = activeRequestRef.current;
    activeRequestRef.current = null;
    if (requestId) void aiApi.stopChat(requestId).catch(() => { if (!activeRequestRef.current) setModelsError('Chat cleared. The stop request could not be confirmed.'); });
    setIsStreaming(false);
    setActiveRequestId(null);
    setActivity('');
    setModelsError(null);
    setReviewedAttachmentKey('');
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setMessages([]);
    onAttachmentsChange([]);
    onDraftChange('');
    followLatest.current = true;
    setAwayFromLatest(false);
    textareaRef.current?.focus();
  };

  const handleClearCurrentChat = () => {
    if (historyAction.current || !historyReady || editorLease === undefined || isStreaming || activeRequestRef.current) return;
    if (!window.confirm('Clear the current conversation? Its messages, prompt and draft attachments will be removed. The conversation stays in Chat history. Other conversations, provider settings and credentials are kept.')) return;
    historyAction.current = true; setHistoryBusy(true);
    pendingHistory.current?.(); pendingHistory.current = undefined;
    const id = chatId.current;
    const lifetime = panelLifetime.current;
    savingHistory.current = savingHistory.current.then(async () => {
      try {
        if (saveFailure.current) throw new Error(`Resolve the pending history save first: ${saveFailure.current}`);
        const history = historyRef.current;
        const current = history.chats.find(chat => chat.id === id);
        const cleared = { id, title: current?.title || 'New conversation', provider, model: current?.model || effectiveModel, updated: Date.now(), messages: [], draft: '' };
        const next = { ...history, chats: [cleared, ...history.chats.filter(chat => chat.id !== id)] };
        next.revision = await saveHistory(projectId, editorLease, next);
        historyRef.current = next; saveFailure.current = '';
        if (lifetime !== panelLifetime.current || chatId.current !== id) return;
        setHistoryError(''); setHistoryVersion(v => v + 1);
        setMessages([]); onDraftChange(''); onAttachmentsChange([]); setReviewedAttachmentKey(''); setActivity(''); setModelsError(null);
        followLatest.current = true; setAwayFromLatest(false); textareaRef.current?.focus();
      } catch (cause) { saveFailure.current = String(cause); if (lifetime === panelLifetime.current) setHistoryError(`Clear Chat did not complete; current messages are retained. ${String(cause)}`); }
      finally { historyAction.current = false; if (lifetime === panelLifetime.current) setHistoryBusy(false); }
    });
  };

  const handleSuggestion = (promptText: string) => {
    onDraftChange(promptText);
    textareaRef.current?.focus();
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await aiApi.testConnection(provider);
      setTestResult(res);
    } catch (e) {
      setTestResult({
        provider,
        success: false,
        message: typeof e === 'string' ? e : 'Connection test failed',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveKey = async () => {
    const key = inputKey.trim();
    if (!key) return;
    setIsSavingKey(true);
    setKeyActionNotice(null);
    try {
      await aiApi.setApiKey(provider, key);
      setModelChecks({});
      setInputKey('');
      await loadCredentials(provider);
      // Auto-test connection and reload models
      void handleTestConnection();
      void loadModels(provider);
      setKeyActionNotice('Key saved to Windows Credential Manager.');
    } catch (e) {
      setKeyActionNotice(typeof e === 'string' ? e : 'Failed to save key');
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleDeleteKey = async () => {
    try {
      await aiApi.deleteApiKey(provider);
      setModelChecks({});
      await loadCredentials(provider);
      setTestResult(null);
      setKeyActionNotice('Key removed from Windows Credential Manager.');
    } catch (e) {
      setKeyActionNotice(typeof e === 'string' ? e : 'Failed to remove key');
    }
  };

  const handleStopStreaming = async () => {
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    try {
      await aiApi.stopChat(requestId);
    } catch {
      if (activeRequestRef.current === requestId) setModelsError('Could not confirm Stop. Try again.');
      return;
    }
    if (activeRequestRef.current !== requestId) return;
    setMessages(prev => prev.map(m => m.status === 'partial' ? { ...m, status: 'cancelled' } : m));
    setIsStreaming(false);
    setActivity('');
    setActiveRequestId(null);
    activeRequestRef.current = null;
  };

  const handleSend = async () => {
    if (!historyReady) { setHistoryError('Load local history before starting a response.'); return; }
    if (historyAction.current || isStreaming || checkRunRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (attachmentsForProject(attachments, projectId).length !== attachments.length) {
      setModelsError('Attachments belong to another project. Remove them before sending.');
      return;
    }
    const sanitized = sanitizeDiagnosticPaths(trimmed);
    if (sanitized !== trimmed) { setSanitizedPreview(sanitized); return; }
    setSanitizedPreview('');

    if (!credStatus?.has_key) {
      setIsKeyModalOpen(true);
      return;
    }

    if (researchEnabled && !researchToken) {
      setResearchError('Research context is unavailable. Save/select the project or disable Research for normal chat.');
      return;
    }
    if (!effectiveModel || !catalogReady || !selectedModel) {
      setModelsError('Load the live catalog and select an available model first.');
      return;
    }

    if (provider === 'openrouter' && freeOnly && selectedModel?.is_free !== true) { setModelsError('Free models only is enabled. Select a free model before sending.'); return; }
    if (researchEnabled && selectedModel?.supports_tools === false) { setModelsError('This model does not advertise tool calling. Disable Research or choose a tool-capable model.'); return; }

    if (attachments.length && reviewedAttachmentKey !== attachmentKey) {
      setModelsError('Review the exact attachment previews and confirm before sending.');
      return;
    }

    let attachedContext = '';
    try { attachedContext = formatAttachments(attachments); }
    catch (cause) { setModelsError(cause instanceof Error ? cause.message : 'Attached context could not be verified safely.'); return; }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    activeRequestRef.current = reqId;
    setActiveRequestId(reqId);
    setIsStreaming(true);
    setActivity('');

    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    };

    const assistantMsgId = `a_${Date.now() + 1}`;
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      status: 'partial',
      content: '',
      timestamp: Date.now() + 1,
    };

    const nextMessages = [...messages, userMsg, assistantMsg];
    followLatest.current = true;
    setMessages(nextMessages);
    onDraftChange('');

    // Revalidate local history. Failed, interrupted, or sensitive messages stay visible
    // locally but cannot poison a later provider request.
    const contextLimit = 12;
    const historySlice = mode === 'web' ? [] : messages.slice(-contextLimit).filter(m => {
      if (m.role === 'assistant' && m.status !== 'complete') return false;
      try { return safeAiContext(m.content, 48_000) === m.content; } catch { return false; }
    });
    if (mode !== 'web' && historySlice.length < Math.min(messages.length, contextLimit)) setActivity('Unsafe or failed history omitted from this request.');
    const outgoingMessages = [
      ...historySlice.map(m => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: `${trimmed}${attachedContext}` },
    ];

    try {
      // Subscribe to streaming chunks
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      const unlisten = await aiApi.subscribeChatStream(reqId, chunk => {
        if (chunk.request_id !== activeRequestRef.current) return;

        if (chunk.activity) setActivity(chunk.activity);
        if (chunk.references) setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, references: [...(m.references || []), ...chunk.references!] } : m));
        if (chunk.done && mode !== 'research') setActivity('');
        if (chunk.delta) {
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId ? { ...m, content: m.content + chunk.delta } : m
            )
          );
        }

        if (chunk.cancelled) {
          if (mode === 'research') setActivity('Research stopped');
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    status: 'cancelled',
                  }
                : m
            )
          );
          setIsStreaming(false);
          setActiveRequestId(null);
          activeRequestRef.current = null;
        }

        if (chunk.error) {
          if (mode === 'research') setActivity(chunk.error.startsWith('Research ') ? 'Research failed' : 'Request failed');
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    status: 'error',
                    content:
                      (m.content ? `${m.content}\n\n` : '') +
                      `⚠️ **Request error:** ${chunk.error}`,
                  }
                : m
            )
          );
          setIsStreaming(false);
          setActiveRequestId(null);
          activeRequestRef.current = null;
        }

        if (chunk.done) {
          setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, status: chunk.cancelled ? 'cancelled' : chunk.error ? 'error' : 'complete' } : m));
          setIsStreaming(false);
          setActiveRequestId(null);
          activeRequestRef.current = null;
        }
      });

      if (activeRequestRef.current !== reqId) { unlisten(); return; }
      unlistenRef.current = unlisten;

      // Start the streaming completion in Rust
      await aiApi.startChat({
        request_id: reqId,
        provider,
        model: effectiveModel,
        max_tokens: responseTokens,
        messages: outgoingMessages,
        research_token: researchEnabled ? researchToken : undefined,
        mode,
      });
      if (activeRequestRef.current !== reqId) { void aiApi.stopChat(reqId).catch(() => {}); return; }
      if (attachments.length) onAttachmentsChange([]);
    } catch (err) {
      if (activeRequestRef.current !== reqId) return;
      const errMsg = typeof err === 'string' ? err : 'Failed to start AI generation';
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantMsgId ? { ...m, status: 'error', content: `⚠️ **Error:** ${errMsg}` } : m
        )
      );
      setIsStreaming(false);
      setActiveRequestId(null);
      activeRequestRef.current = null;
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleSend();
    }
  };

  const providerLabel = provider === 'openrouter' ? 'OpenRouter' : 'NVIDIA NIM';
  const providerKeyUrl =
    provider === 'openrouter' ? 'https://openrouter.ai/keys' : 'https://build.nvidia.com/';

  return (
    <aside className="qe-ai-panel" aria-label="AI Assistant">
      {historyError && <p role="alert">History not saved: {historyError}</p>}
      <details data-history-version={historyVersion}><summary>Chat history</summary>
        <button disabled={isStreaming || historyBusy || !historyReady} onClick={() => { if (!window.confirm('Permanently clear all saved conversations for this project? Export anything you need first.')) return; pendingHistory.current = undefined; savingHistory.current = savingHistory.current.then(async () => { try { const next = { ...historyRef.current, chats: [] }; next.revision = await saveHistory(projectId, editorLease!, next); historyRef.current = next; handleClearChat(false); setHistoryVersion(v => v + 1); } catch (e) { setHistoryError(String(e)); } }); }}>Clear All History</button>
        <input aria-label="Search chat history" placeholder="Search conversations" value={historySearch} onChange={e => setHistorySearch(e.target.value)} />
        {historyRef.current.chats.filter(c => `${c.title} ${c.messages.map(m => m.content).join(' ')}`.toLowerCase().includes(historySearch.toLowerCase())).map(chat => <div key={chat.id}>
          <button disabled={isStreaming || historyBusy} title={chat.messages[chat.messages.length - 1]?.content.slice(0, 160)} onClick={() => { pendingHistory.current?.(); followLatest.current = true; chatId.current = chat.id; setMessages(chat.messages); onDraftChange(chat.draft); onProviderChange(chat.provider); if (chat.provider === 'nvidia-nim') setNimModel(chat.model); else onModelChange(chat.model); onAttachmentsChange([]); }}>{chat.title} · {new Date(chat.updated).toLocaleString()} · {chat.provider}/{chat.model}</button>
          <button onClick={() => { if (window.confirm('Exported chats may contain sensitive code or logs. Continue?')) void invoke('chat_history_export', { projectId, chatId: chat.id }).catch(e => setHistoryError(String(e))); }}>Export Markdown</button>
          <button disabled={isStreaming || historyBusy} onClick={() => { const title = window.prompt('Conversation title', chat.title)?.trim(); if (!title) return; pendingHistory.current?.(); savingHistory.current = savingHistory.current.then(async () => { const next = { ...historyRef.current, chats: historyRef.current.chats.map(c => c.id === chat.id ? { ...c, title: redactForSharing(title.slice(0, 200)) } : c) }; try { next.revision = historyRef.current.revision; next.revision = await saveHistory(projectId, editorLease!, next); historyRef.current = next; setHistoryVersion(v => v + 1); } catch (e) { setHistoryError(String(e)); } }); }}>Rename</button>
          <button disabled={isStreaming || historyBusy} onClick={() => { if (!window.confirm('Delete this saved conversation?')) return; savingHistory.current = savingHistory.current.then(async () => { pendingHistory.current = undefined; const next = { ...historyRef.current, chats: historyRef.current.chats.filter(c => c.id !== chat.id) }; try { next.revision = await saveHistory(projectId, editorLease!, next); historyRef.current = next; if (chatId.current === chat.id) handleClearChat(false); setHistoryVersion(v => v + 1); } catch (e) { setHistoryError(String(e)); } }); }}>Delete Chat</button>
        </div>)}
      </details>
      <header className="qe-ai-header">
        <div className="qe-ai-header-top">
          <div className="qe-ai-title">
            <Bot size={15} className="qe-ai-title-icon" aria-hidden="true" />
            <h2>AI Assistant</h2>
          </div>
          <div className="qe-ai-header-actions">
            <button
              type="button"
              className="qe-ai-btn-quiet"
              title="Start a new conversation; saved conversations remain in History"
              aria-label="New chat"
              disabled={historyBusy || !historyReady}
              onClick={() => handleClearChat()}
            >
              <Plus size={13} />
              <span>New Chat</span>
            </button>
            <button type="button" className="qe-ai-btn-quiet" disabled={isStreaming || historyBusy || !historyReady || editorLease === undefined || (!messages.length && !draft && !attachments.length)} title={isStreaming ? 'Stop generation before clearing this conversation' : 'Clear only this conversation; keep its history entry and other chats'} onClick={handleClearCurrentChat}>Clear Chat</button>
            <button
              type="button"
              className="qe-ai-btn-quiet"
              title="Hide AI Assistant · conversation retained"
              aria-label="Hide AI Assistant"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <section className={`qe-ai-configuration ${configExpanded ? 'is-expanded' : ''}`} aria-label="AI Configuration">
          <button type="button" className="qe-ai-configuration-summary" aria-expanded={configExpanded} aria-controls="qe-ai-configuration-controls" onClick={() => { const next = !configExpanded; setConfigExpanded(next); try { localStorage.setItem('devflow-ai-config-expanded', String(next)); } catch { /* Session preference remains usable. */ } }} onKeyDown={event => { if (event.key === 'Escape' && configExpanded) { event.preventDefault(); setConfigExpanded(false); try { localStorage.setItem('devflow-ai-config-expanded', 'false'); } catch { /* Optional preference. */ } } }}>
            <span className={`qe-ai-status-dot ${isTesting ? 'is-testing' : credStatus?.has_key ? 'is-connected' : 'is-disconnected'}`} aria-hidden="true" />
            <span className="qe-ai-configuration-label">AI Configuration</span>
            <span className="qe-ai-configuration-selection" title={`${providerLabel} · ${effectiveModel || 'No model selected'}`}>{providerLabel} · {selectedModel?.name || effectiveModel || 'No model selected'}</span>
            {(!effectiveModel || !selectedModel || !credStatus?.has_key) && <AlertCircle size={14} className="qe-ai-configuration-warning" aria-label={!credStatus?.has_key ? 'Provider unavailable: API key not configured' : 'No available model selected'} />}
            <ChevronDown size={14} className="qe-ai-configuration-chevron" aria-hidden="true" />
          </button>
          <div id="qe-ai-configuration-controls" className="qe-ai-configuration-controls" hidden={!configExpanded}>
        <div className="qe-ai-capability-row"><span className="qe-ai-readonly-badge"><Shield size={11} aria-hidden="true" />Read-only</span></div>
        {researchError && <p role="alert" className="qe-ai-research-status">{researchError}</p>}
        <div className="qe-ai-controls-grid">
          {/* Provider selector */}
          <div className="qe-ai-control-field">
            <label htmlFor="qe-ai-provider-select" className="qe-ai-field-label">
              Provider
            </label>
            <select
              id="qe-ai-provider-select"
              className="qe-ai-select"
              value={provider}
              disabled={isStreaming || isSavingKey || isTesting || isKeyModalOpen}
              onChange={e => onProviderChange(e.target.value as AiProvider)}
              aria-label="AI Provider"
            >
              <option value="openrouter">OpenRouter</option>
              <option value="nvidia-nim">NVIDIA NIM</option>
            </select>
          </div>

          {provider === 'nvidia-nim' && !showModelPicker ? (
            <div className="qe-ai-control-field qe-ai-default-model">
              <span className="qe-ai-field-label">Model · {nimModel ? 'selected' : 'automatic'}</span>
              <div><span title={effectiveModel}>{nimModel || automaticNim?.name || (modelsLoading ? 'Loading live catalog…' : 'Catalog unavailable')}</span><button type="button" className="qe-ai-btn-quiet" disabled={isStreaming || historyBusy} onClick={() => { setShowModelPicker(true); void loadModels(provider); }}>Change</button></div>
            </div>
          ) : <div className="qe-ai-control-field">
            <label htmlFor="qe-ai-model-select" className="qe-ai-field-label">
              Model
            </label>
            <input className="qe-ai-select" aria-label="Search models" placeholder="Search name or ID" value={modelSearch} onChange={event => setModelSearch(event.target.value)} /><div className="qe-ai-model-input-group">
              <select
                id="qe-ai-model-select"
                className="qe-ai-select"
                disabled={isStreaming || modelsLoading}
                value={effectiveModel}
                onChange={e => provider === 'nvidia-nim' ? setNimModel(e.target.value) : onModelChange(e.target.value)}
                title={effectiveModel ? `Selected: ${effectiveModel}` : 'Select a model'}
                aria-label="AI Model"
              >
                {provider === 'openrouter' && model && !visibleModels.some(item => item.id === model) && <option value={model}>{selectedModel ? 'Selected paid model (choose a free model)' : 'Not in current catalog'} · {model}</option>}
                {!effectiveModel && <option value="">{provider === 'nvidia-nim' ? 'Preferred NVIDIA model is not in the live catalog' : 'Choose a model'}</option>}
                {models.length === 0 ? (
                  provider === 'openrouter' ? <option value="">{modelsLoading ? 'Loading models…' : 'No models loaded'}</option> : null
                ) : (
                  visibleModels.map(m => (
                    <option key={m.id} value={m.id} className={`qe-ai-model-option is-${modelChecks[checkKey(m.id)]?.status || 'unknown'}`}>
                      {modelOption(m.id, m.name || m.id)}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="qe-ai-model-refresh-btn"
                disabled={isStreaming || modelsLoading}
                title="Refresh model list"
                aria-label="Refresh model list"
                onClick={() => void loadModels(provider)}
              >
                <RefreshCw size={12} className={modelsLoading ? 'qe-ai-spinning' : ''} />
              </button>
            </div>
          </div>

          }

          {/* Connection status row */}
          <div className="qe-ai-status-row">
            <span
              className="qe-ai-status-pill"
              title={
                credStatus?.has_key
                  ? `Windows Credential Manager: ${credStatus.masked}`
                  : 'No API key configured for this provider'
              }
            >
              <span
                className={`qe-ai-status-dot ${
                  isTesting
                    ? 'is-testing'
                    : credStatus?.has_key
                    ? 'is-connected'
                    : 'is-disconnected'
                }`}
                aria-hidden="true"
              />
              {isTesting
                ? 'Testing connection…'
                : credStatus?.has_key
                ? 'Key configured'
                : 'No key set'}
            </span>

            <button
              type="button"
              className="qe-ai-key-trigger"
              onClick={() => {
                setKeyActionNotice(null);
                setIsKeyModalOpen(true);
              }}
              disabled={isModelChecking}
              aria-label="Configure API Key"
              title="Configure API key stored in Windows Credential Manager"
            >
              <Key size={11} />
              <span>{credStatus?.has_key ? 'Manage Key' : 'Set Key'}</span>
            </button>
          </div>
        </div>
        <details className="qe-ai-settings"><summary>Settings</summary>
        {provider === 'nvidia-nim' && !nimModel && <p>Preferred: NVIDIA Nemotron 3.5 Bolt E4B. API identity and chat access are unverified. Select a catalog model explicitly; no substitute is selected.</p>}<div className="qe-ai-provider-options">
          {provider === 'openrouter' && <label><input type="checkbox" checked={freeOnly} onChange={event => setFreeOnly(event.target.checked)} />Free models only</label>}
          <label>Response limit <select value={responseTokens} disabled={isStreaming || historyBusy} onChange={event => setResponseTokens(Number(event.target.value))} aria-label="Maximum response tokens">{[256,512,1024,2048,4096].map(tokens => <option key={tokens} value={tokens}>{tokens} tokens</option>)}</select></label>
          <button type="button" className="qe-ai-btn-quiet" disabled={isTesting || isModelChecking || !credStatus?.has_key} onClick={() => void handleTestConnection()}>{isTesting ? 'Checking account…' : 'Account status'}</button>
        </div>
        {testResult && <p className="qe-ai-account-status" role="status">{testResult.message}</p>}
        {catalogReady && effectiveModel && !selectedModel && <p className="qe-ai-account-status" role="alert">Selected model is absent from the refreshed catalog. Choose a current model; it has not been substituted.</p>}
        {researchEnabled && selectedModel?.supports_tools === false && <p className="qe-ai-account-status" role="status">This model does not advertise Research tools. Disable Research for normal chat, or select a tool-capable model.</p>}
        <div className="qe-ai-model-checks">
          <div className="qe-ai-model-check-actions">
            <span className={`qe-ai-model-health is-${selectedCheck?.status || 'unknown'}`}>
              <span aria-hidden="true">●</span> {selectedCheck?.status === 'working' ? 'Working' : selectedCheck?.status === 'unavailable' ? 'Failed check' : selectedCheck ? 'Inconclusive' : 'Untested'} · {researchEnabled ? 'Research' : 'Chat'}
            </span>
            {isModelChecking ? <button type="button" className="qe-ai-btn-quiet" onClick={stopModelChecks}><Square size={11} />Stop checks</button> : <button type="button" className="qe-ai-btn-quiet" disabled={isStreaming || !credStatus?.has_key || !selectedModel || !catalogReady || (provider === 'openrouter' && freeOnly && !selectedModel.is_free)} onClick={() => void checkModels(false)}>Check selected</button>}
          </div>
          <div className="qe-ai-model-check-note" role="status" aria-live="polite">
            {isModelChecking ? `Checking ${checkingModel || 'model'}…` : selectedCheck ? `${selectedCheck.message} Checked ${selectedCheck.checkedAt}.` : 'Untested models stay gray. Checks may use provider credits.'}
          </div>
          <div className="qe-ai-model-batch-row">
            <span>Point-in-time results</span>
            <button type="button" className="qe-ai-btn-quiet" disabled={isStreaming || isModelChecking || !catalogReady || !credStatus?.has_key || ![effectiveModel, ...visibleModels.map(item => item.id)].some(id => id && visibleModels.some(item => item.id === id) && !modelChecks[checkKey(id)])} title="Check up to five untested loaded models, sequentially. Each makes one small provider request and may use credits." onClick={() => void checkModels(true)}>Check next 5</button>
          </div>
          {checkedModels.length > 0 && <details className="qe-ai-checked-models">
            <summary>Checked models ({checkedModels.length})</summary>
            <div role="group" aria-label={`Checked ${researchEnabled ? 'Research' : 'Chat'} models`}>
              {checkedModels.map(check => <button type="button" key={check.model}
                className={`qe-ai-checked-model is-${check.status}`} disabled={isStreaming || historyBusy}
                aria-pressed={effectiveModel === check.model} title={`${check.message} Checked ${check.checkedAt}.`}
                onClick={() => provider === 'nvidia-nim' ? setNimModel(check.model) : onModelChange(check.model)}>
                <span>{check.model}</span><span>{check.status === 'working' ? '✓ Working' : check.status === 'unavailable' ? '✕ Failed' : '○ Inconclusive'}</span>
              </button>)}
            </div>
          </details>}
        </div>
        </details>
          </div>
        </section>
      </header>
      <div role="status" aria-live="polite" className="qe-ai-research-status">{activity || (isStreaming ? 'Generating…' : mode === 'research' ? researchToken ? 'Research ready' : 'Research unavailable' : '')}</div>

      {/* API Key Modal / Dialog */}
      {isKeyModalOpen && (
        <div
          className="qe-ai-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="qe-ai-modal-heading"
          onClick={e => {
            if (e.target === e.currentTarget) setIsKeyModalOpen(false);
          }}
          onKeyDown={e => {
            if (e.key === 'Escape') setIsKeyModalOpen(false);
          }}
        >
          <div className="qe-ai-modal">
            <div className="qe-ai-modal-header">
              <div className="qe-ai-modal-title" id="qe-ai-modal-heading">
                <Key size={14} className="qe-ai-modal-title-icon" />
                <span>API Key — {providerLabel}</span>
              </div>
              <button
                type="button"
                className="qe-ai-btn-quiet"
                aria-label="Close modal"
                onClick={() => setIsKeyModalOpen(false)}
              >
                <X size={14} />
              </button>
            </div>

            <div className="qe-ai-modal-security-note">
              <Shield size={13} />
              <span>
                Keys are stored securely in Windows Credential Manager and are never stored in
                plaintext files or web storage.
              </span>
            </div>

            {credStatus?.has_key && (
              <div className="qe-ai-modal-key-status">
                <span>Stored key:</span>
                <span>{credStatus.masked}</span>
              </div>
            )}

            <div className="qe-ai-modal-input-wrap">
              <input
                type={showKeyPlaintext ? 'text' : 'password'}
                className="qe-ai-modal-input"
                placeholder={
                  provider === 'openrouter'
                    ? 'Enter OpenRouter key (sk-or-v1-…)'
                    : 'Enter NVIDIA NIM key (nvapi-…)'
                }
                value={inputKey}
                onChange={e => setInputKey(e.target.value)}
                aria-label={`${providerLabel} API key`}
              />
              <button
                type="button"
                className="qe-ai-modal-input-toggle"
                title={showKeyPlaintext ? 'Hide key' : 'Show key'}
                onClick={() => setShowKeyPlaintext(!showKeyPlaintext)}
              >
                {showKeyPlaintext ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>

            {testResult && (
              <div
                className={`qe-ai-modal-test-box ${
                  testResult.success ? 'is-success' : 'is-error'
                }`}
              >
                {testResult.success ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}
                <span>{testResult.message}</span>
              </div>
            )}

            {keyActionNotice && (
              <div className="qe-ai-modal-test-box is-success">
                <Check size={13} />
                <span>{keyActionNotice}</span>
              </div>
            )}

            <div className="qe-ai-modal-actions">
              <div className="qe-ai-modal-left-actions">
                <button
                  type="button"
                  className="qe-ai-btn-secondary"
                  disabled={!credStatus?.has_key || isTesting}
                  onClick={() => void handleTestConnection()}
                  title="Verify your key against the official API"
                >
                  {isTesting ? 'Testing…' : 'Test Connection'}
                </button>
                {credStatus?.has_key && (
                  <button
                    type="button"
                    className="qe-ai-btn-danger-quiet"
                    onClick={() => void handleDeleteKey()}
                    title="Remove this key from Windows Credential Manager"
                  >
                    <Trash2 size={12} />
                    <span>Remove</span>
                  </button>
                )}
              </div>

              <div className="qe-ai-modal-right-actions">
                <a
                  href={providerKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="qe-ai-btn-quiet"
                  title="Open official key portal"
                >
                  <span>Get Key</span>
                  <ExternalLink size={11} />
                </a>
                <button
                  type="button"
                  className="qe-ai-btn-primary"
                  disabled={!inputKey.trim() || isSavingKey}
                  onClick={() => void handleSaveKey()}
                >
                  {isSavingKey ? 'Saving…' : 'Save Key'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Only this area scrolls; the action row belongs to its viewport. */}
      <section className="qe-ai-conversation" aria-label="Conversation">
      <div ref={messageAreaRef} className="qe-ai-message-area" tabIndex={0} aria-label="Conversation messages">
        <div ref={messageContentRef} className="qe-ai-message-content">
        {messages.length === 0 ? (
          <div className="qe-ai-empty">
            <div className="qe-ai-empty-icon" aria-hidden="true">
              <Sparkles size={22} />
            </div>
            <h3 className="qe-ai-empty-title">DevFlow AI Assistant</h3>
            <p className="qe-ai-empty-desc">
              Context-aware pair programming and debugging assistance powered by {providerLabel}.
            </p>
            <div className="qe-ai-suggestions" role="group" aria-label="Starter suggestions">
              <span className="qe-ai-suggestions-header">Quick prompts</span>
              {AI_SUGGESTIONS.map(s => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.kind}
                    type="button"
                    className="qe-ai-suggestion-chip"
                    onClick={() => handleSuggestion(s.prompt)}
                  >
                    <Icon size={13} className="qe-ai-chip-icon" />
                    <span>{s.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="qe-ai-message-list">
            {messages.map((msg, idx) => <ConversationMessage key={msg.id} msg={msg}
              isGeneratingThis={isStreaming && idx === messages.length - 1 && msg.role === 'assistant'}
              onOpenReference={openReference} />)}
          </div>
        )}
        </div>
      </div>
      <div className="qe-ai-scroll-controls">
        {awayFromLatest && <button type="button" className="qe-ai-scroll-bubble" onClick={scrollMessages}>
          <ArrowDown size={14} aria-hidden="true" /><span>Jump to latest</span>
        </button>}
      </div>
      </section>
      {/* Composer */}
      <footer className="qe-ai-composer">
        <div
          className="qe-ai-attachments"
          role="group"
          aria-label="User controlled context attachments"
        >
          {attachments.length > 0 && <div className="qe-ai-context-summary">
            <span className="qe-ai-attachments-label">{attachments.length ? `${attachments.length} attachments` : 'Context'}</span>
            <span className="qe-ai-phase-tag">{attachments.length ? `${attachments.reduce((size, item) => size + contextByteSize(item.content), 0).toLocaleString()} bytes` : 'Added only when selected'}</span>
          </div>}
          <details className="qe-ai-attach-menu" ref={attachMenuRef} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}><summary>Attach <ChevronDown size={12} aria-hidden="true" /></summary><div className="qe-ai-attach-options"><div className="qe-ai-attachments-row" onClick={event => { if ((event.target as Element).closest('button:not(:disabled)') && attachMenuRef.current) { attachMenuRef.current.open = false; attachMenuRef.current.querySelector('summary')?.focus(); } }}>
            <button type="button" className="qe-ai-attachment-chip" disabled={historyBusy || !canAttachCurrentFile} title={canAttachCurrentFile ? 'Attach a reviewed snapshot of the current file' : 'Open a file in Quick Editor first'} onClick={onAttachCurrentFile}>
              <FileText size={12} />
              <span>Current File</span>
            </button>
            <button type="button" className="qe-ai-attachment-chip" disabled={historyBusy || !canAttachSelectedCode} title={canAttachSelectedCode ? 'Attach only the selected editor text' : 'Select code in the open CodeMirror editor first'} onClick={onAttachSelectedCode}>
              <Code2 size={12} />
              <span>Selected Code</span>
            </button>
            <button type="button" className="qe-ai-attachment-chip" disabled={historyBusy || !canAttachSelectedLogs} title={canAttachSelectedLogs ? 'Attach explicitly checked entries from the current project Logs panel' : 'Check entries in the current project Logs panel first'} onClick={onAttachSelectedLogs}>
              <Terminal size={12} />
              <span>Selected Logs</span>
            </button>
            <button type="button" className="qe-ai-attachment-chip" disabled={historyBusy || !canAttachProjectContext} title="Attach bounded project metadata and a secure file tree, without source contents" onClick={onAttachProjectContext}><FolderTree size={12} /><span>Project Context</span></button>
          </div>
          <AiFilePicker key={`${projectId}:${projectRoot}`} projectId={projectId} projectRoot={projectRoot} attachments={attachments} onChange={items => { onAttachmentsChange(items); if (attachMenuRef.current) { attachMenuRef.current.open = false; attachMenuRef.current.querySelector('summary')?.focus(); } }} />
          </div></details>
          <label className="qe-ai-mode-control"><span className="qe-ai-sr-only">Assistant mode</span><select aria-label="Assistant mode" value={mode} disabled={isStreaming || historyBusy} onChange={event => { setMode(event.target.value as AssistantMode); setActivity(''); }}><option value="chat">Chat</option><option value="research">Research</option><option value="web">Web</option></select></label>
          {attachments.length > 0 && <button type="button" disabled={historyBusy} onClick={() => onAttachmentsChange([])}>Clear attachments</button>}
          {attachments.reduce((size, item) => size + contextByteSize(item.content), 0) > 6000 && <p>Large context may consume significant provider tokens.</p>}
          {attachments.length > 0 && <div className="qe-ai-attachment-list">
            {attachments.map(attachment => <div className="qe-ai-selected-attachment" key={attachment.id}>
              <details className="qe-ai-attachment-preview">
                <summary><span>{attachment.label}</span><span>{contextByteSize(attachment.content).toLocaleString()} bytes</span></summary>
                {attachment.unsaved && <p className="qe-ai-unsaved-note">Unsaved editor draft included. This snapshot will not save the file.</p>}
                <pre tabIndex={0} aria-label={`Exact attachment preview: ${attachment.label}`}>{attachment.content}</pre>
              </details>
              <button type="button" disabled={historyBusy} aria-label={`Remove ${attachment.label}`} title="Remove attachment" onClick={() => onAttachmentsChange(attachments.filter(item => item.id !== attachment.id))}>×</button>
            </div>)}
            <label className="qe-ai-review-context"><input type="checkbox" checked={reviewedAttachmentKey === attachmentKey && !!attachmentKey} onChange={event => setReviewedAttachmentKey(event.target.checked ? attachmentKey : '')} />I reviewed this exact context and approve sending it with my next message.</label>
          </div>}
        </div>

        {sanitizedPreview && <div className="qe-ai-sanitize-preview" role="alert"><strong>Review sanitized message</strong><p>Private paths were replaced. The original has not been sent.</p><pre>{sanitizedPreview}</pre><button type="button" onClick={() => { onDraftChange(sanitizedPreview); setSanitizedPreview(''); }}>Use sanitized message</button><button type="button" onClick={() => setSanitizedPreview('')}>Keep editing</button></div>}

        {/* Text input */}
        <div className="qe-ai-input-wrap">
          <textarea
            ref={textareaRef}
            className="qe-ai-textarea"
            placeholder={mode === 'web' ? 'Ask a general question…' : mode === 'research' ? 'Ask about this project…' : 'Ask anything or attach context…'}
            value={draft}
            disabled={isStreaming || historyBusy || !historyReady}
            onChange={e => { onDraftChange(e.target.value); setSanitizedPreview(''); }}
            onKeyDown={handleKeyDown}
            rows={3}
            aria-label="Message prompt"
          />
        </div>

        {/* Composer footer */}
        <div className="qe-ai-composer-footer">
          <span className="qe-ai-footer-note">
            {isStreaming
              ? 'Generating response…'
              : !credStatus?.has_key
              ? 'Configure API key to chat'
              : 'Enter to send · Shift+Enter for newline'}
          </span>

          {isStreaming ? (
            <button
              type="button"
              className="qe-ai-stop-btn"
              onClick={() => void handleStopStreaming()}
              aria-label="Stop generation"
            >
              <Square size={12} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="button"
              className="qe-ai-send-btn"
              disabled={historyBusy || !historyReady || isModelChecking || !draft.trim() || !credStatus?.has_key || !catalogReady || !selectedModel || (provider === 'openrouter' && freeOnly && !selectedModel.is_free) || (researchEnabled && (!researchToken || selectedModel.supports_tools === false))}
              aria-label="Send message"
              onClick={() => void handleSend()}
            >
              <Send size={13} />
              <span>Send</span>
            </button>
          )}
        </div>

        {modelsError && (
          <div className="qe-ai-phase-banner" role="alert">
            <AlertCircle size={13} className="qe-ai-banner-icon" />
            <span>{modelsError}</span>
            <button
              type="button"
              className="qe-ai-banner-dismiss"
              aria-label="Dismiss alert"
              onClick={() => setModelsError(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </footer>
    </aside>
  );
}
