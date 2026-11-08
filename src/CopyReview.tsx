import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CopyExport } from './editor-api';
import { contextByteSize } from './ai-context';

/** Receives only a native-sanitized snapshot; original secrets never enter this dialog. */
export default function CopyReview({ result, budget, busy, cancel, approve }: { result: CopyExport; budget: number; busy: boolean; cancel: () => void; approve: () => void }) {
  const dismiss = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dismiss.current?.focus(); return () => { if (previous?.isConnected) previous.focus(); }; }, []);
  return createPortal(<div className="dialog-backdrop"><section className="dialog qe-copy-review" role="dialog" aria-modal="true" aria-labelledby="qe-copy-review-title" aria-describedby="qe-copy-review-description" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); cancel(); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
  }}><h2 id="qe-copy-review-title">Review sanitized copy</h2><p id="qe-copy-review-description">Identifiable credentials were masked. Review before sharing. This copies to your local clipboard; it does not send an AI request or modify source files.</p>
    <p>{result.files} included file(s); {contextByteSize(result.text).toLocaleString()} / {budget.toLocaleString()} UTF-8 bytes</p>
    <ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    <pre tabIndex={0} aria-label="Sanitized clipboard preview">{result.text}</pre>
    <div className="dialog-actions"><button ref={dismiss} className="button" disabled={busy} onClick={cancel}>Cancel</button><button className="button button-primary" disabled={busy} onClick={approve}>{busy ? 'Checking source...' : 'Copy Sanitized Version'}</button></div>
  </section></div>, document.body);
}
