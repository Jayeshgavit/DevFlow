import React, { memo, useEffect, useRef, useState } from 'react';
import { highlightTree, classHighlighter } from '@lezer/highlight';
import { Copy } from 'lucide-react';
// Reuse installed language parsers; unsupported fences remain plain text.
export default memo(function AiCode({ className, children }: { className?: string; children?: React.ReactNode }) {
  const text = String(children ?? '');
  const language = className?.replace('language-', '') || '';
  const [highlight, setHighlight] = useState<{ text: string; language: string; parts: { from: number; to: number; classes: string }[] }>({ text: '', language: '', parts: [] });
  const parts = highlight.text === text && highlight.language === language ? highlight.parts : [];
  useEffect(() => { let disposed = false;
    const load = async () => {
      if (text.length > 64000) return;
      const support = /^(js|jsx|javascript|ts|tsx|typescript)$/.test(language) ? (await import('@codemirror/lang-javascript')).javascript({ typescript: /^(ts|tsx|typescript)$/.test(language), jsx: /^(jsx|tsx)$/.test(language) }) : language === 'python' || language === 'py' ? (await import('@codemirror/lang-python')).python() : language === 'json' ? (await import('@codemirror/lang-json')).json() : null;
      if (!support || disposed) return;
      const next: typeof parts = [];
      highlightTree(support.language.parser.parse(text), classHighlighter, (from, to, classes) => next.push({ from, to, classes }));
      if (!disposed) setHighlight({ text, language, parts: next });
    }; void load().catch(() => {}); return () => { disposed = true; };
  }, [text, language]);
  let cursor = 0; const nodes: React.ReactNode[] = [];
  for (const part of parts) { nodes.push(text.slice(cursor, part.from), <span key={part.from} className={part.classes}>{text.slice(part.from, part.to)}</span>); cursor = part.to; }
  nodes.push(text.slice(cursor));
  return <code className={className} data-language={language}>{nodes}</code>;
});


// Feedback belongs to the action, avoiding duplicate panel/editor notifications.
export function AiCopyButton({ text, label, className }: { text: string; label: string; className: string }) {
  const [result, setResult] = useState<'idle' | 'copied' | 'error'>('idle');
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);
  useEffect(() => {
    if (result === 'idle') return;
    const timer = setTimeout(() => setResult('idle'), 2500);
    return () => clearTimeout(timer);
  }, [result]);
  return <span className="qe-ai-copy-action">
    <button type="button" className={className} disabled={busy} aria-label={label}
      onClick={async () => {
        const id = ++attempt.current;
        setBusy(true); setResult('idle');
        try { await navigator.clipboard.writeText(text); if (id === attempt.current) setResult('copied'); }
        catch { if (id === attempt.current) setResult('error'); }
        finally { if (id === attempt.current) setBusy(false); }
      }}><Copy size={12} aria-hidden="true" />{result === 'copied' ? 'Copied' : label}</button>
    <span className={result === 'error' ? 'qe-ai-copy-error' : 'qe-ai-sr-only'} role="status">
      {result === 'copied' ? `${label}: copied` : result === 'error' ? 'Copy failed. Try again or select the text to copy.' : ''}
    </span>
  </span>;
}

export function AiCodeBlock({ children }: { children?: React.ReactNode }) {
  const code = React.isValidElement<{ className?: string; children?: React.ReactNode }>(children) ? children.props : undefined;
  const language = code?.className?.replace('language-', '') || 'text';
  // Read the Markdown code node's source, never highlighted DOM/UI text.
  const source = String(code?.children ?? '');
  return <div className="qe-ai-fenced">
    <div className="qe-ai-code-header"><span className="qe-ai-code-language">{language}</span>
      <AiCopyButton text={source} label="Copy code" className="qe-ai-copy-code-btn" />
    </div>
    <pre>{children}</pre>
  </div>;
}
