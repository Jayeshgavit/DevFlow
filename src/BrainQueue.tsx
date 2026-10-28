import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, Lightbulb, ListTodo, MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from './components';
import './brain-queue.css';

type Kind = 'task' | 'note' | 'prompt';
type Item = { id: string; text: string; done: boolean; kind: Kind };
const LIMIT = 100;
const TEXT_LIMIT = 4000;
const keyFor = (projectId: string) => `devflow-brain-queue-v1:${projectId}`;

function load(projectId: string): Item[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyFor(projectId)) || '[]');
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value.slice(0, LIMIT).flatMap((item): Item[] => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > TEXT_LIMIT || typeof item.done !== 'boolean') return [];
      ids.add(item.id);
      return [{ id: item.id, text: item.text, done: item.done, kind: item.kind === 'note' || item.kind === 'prompt' ? item.kind : 'task' }];
    });
  } catch { return []; }
}

export default function BrainQueue({ projectId }: { projectId: string }) {
  const [items, setItems] = useState(() => load(projectId));
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('task');
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all');
  const [expanded, setExpanded] = useState<string>();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string>();
  const [editText, setEditText] = useState('');
  const [feedback, setFeedback] = useState('');
  const [confirm, setConfirm] = useState<{ description: string; confirmText: string; action: () => void }>();
  const [storageError, setStorageError] = useState(false);
  const commit = (next: Item[]): boolean => {
    try { localStorage.setItem(keyFor(projectId), JSON.stringify(next)); setItems(next); setStorageError(false); return true; }
    catch { setStorageError(true); return false; }
  };
  const add = () => {
    const text = draft.trim();
    if (!text || items.length >= LIMIT) return;
    if (commit([...items, { id: crypto.randomUUID(), text, done: false, kind }])) { setDraft(''); setFilter('all'); setFeedback('Added to queue'); }
  };
  const update = (id: string, change: Partial<Item>) => commit(items.map(item => item.id === id ? { ...item, ...change } : item));
  const move = (index: number, delta: number) => {
    const next = [...items];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    commit(next);
  };
  const copy = async (item: Item) => {
    try { await navigator.clipboard.writeText(item.text); setFeedback(`Copied item ${items.indexOf(item) + 1}`); }
    catch { setFeedback('Could not copy item'); }
  };
  const completed = items.filter(item => item.done).length;
  const visible = items.filter(item => filter === 'all' || item.done === (filter === 'done'));
  return <section className="brain-queue" aria-label="Brain Queue" onContextMenu={event => event.stopPropagation()}>
    <button className="brain-queue-toggle" aria-expanded={open} aria-controls="brain-queue-content" onClick={() => setOpen(value => !value)}><span className="brain-queue-title"><Lightbulb size={15} />Brain Queue</span><span className="brain-queue-count">{items.length}</span>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
    {open && <div id="brain-queue-content" className="brain-queue-content">
      <div className="brain-queue-summary"><span>{items.length - completed} open</span><span>{completed} completed</span></div>
      <div className="brain-queue-progress" role="progressbar" aria-label="Brain Queue completed" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={items.length || 1}><span style={{ width: `${items.length ? completed / items.length * 100 : 0}%` }} /></div>
      <div className="brain-queue-composer"><div className="brain-queue-kinds" role="group" aria-label="New item type">{(['task', 'note', 'prompt'] as const).map(option => <button key={option} aria-pressed={kind === option} onClick={() => setKind(option)}>{option}</button>)}</div><label htmlFor="brain-queue-add" className="brain-queue-sr">New {kind}</label><textarea id="brain-queue-add" value={draft} maxLength={TEXT_LIMIT} rows={kind === 'prompt' ? 4 : 2} placeholder={kind === 'prompt' ? 'Paste or write a prompt…' : kind === 'note' ? 'Capture an idea…' : 'What needs doing?'} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); add(); } }} /><div className="brain-queue-composer-footer"><small>Ctrl+Enter · {draft.length}/{TEXT_LIMIT}</small><button disabled={!draft.trim() || items.length >= LIMIT} onClick={add}><Plus size={14} />Add</button></div></div>
      {items.length > 0 && <div className="brain-queue-filters" role="group" aria-label="Filter Brain Queue">{(['all', 'open', 'done'] as const).map(option => <button key={option} aria-pressed={filter === option} onClick={() => setFilter(option)}>{option === 'all' ? 'All' : option === 'open' ? 'Open' : 'Done'}<span>{option === 'all' ? items.length : option === 'open' ? items.length - completed : completed}</span></button>)}</div>}
      {!items.length && <div className="brain-queue-empty"><Lightbulb size={20} /><strong>Clear head, clear queue.</strong><span>Capture the next task, idea, or AI prompt for this project.</span></div>}
      {items.length > 0 && !visible.length && <p className="brain-queue-no-results">No {filter === 'done' ? 'completed' : 'open'} items.</p>}
      <div className="brain-queue-list">{visible.map(item => { const index = items.indexOf(item); const Icon = item.kind === 'note' ? Lightbulb : item.kind === 'prompt' ? MessageSquareText : ListTodo; const long = item.text.length > 180 || item.text.split('\n').length > 4; return <article className={`brain-queue-item ${item.done ? 'is-done' : ''}`} key={item.id}>
        <div className="brain-queue-item-top"><span className="brain-queue-kind"><Icon size={12} />{item.kind}</span><span className="brain-queue-position">{index + 1}/{items.length}</span></div>
        <label className="brain-queue-check"><input type="checkbox" checked={item.done} aria-label={`Complete item ${index + 1}`} onChange={event => update(item.id, { done: event.target.checked })} /></label>
        <div className="brain-queue-body">{editing === item.id ? <><textarea aria-label={`Edit item ${index + 1}`} value={editText} maxLength={TEXT_LIMIT} rows={Math.min(8, Math.max(3, editText.split('\n').length))} onChange={event => setEditText(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setEditing(undefined); if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && editText.trim()) { event.preventDefault(); if (commit(items.map(entry => entry.id === item.id ? { ...entry, text: editText.trim() } : entry))) setEditing(undefined); } }} /><div className="brain-queue-edit-actions"><button disabled={!editText.trim()} onClick={() => { if (commit(items.map(entry => entry.id === item.id ? { ...entry, text: editText.trim() } : entry))) setEditing(undefined); }}><Check size={13} />Save</button><button onClick={() => setEditing(undefined)}>Cancel</button></div></> : <><button className={`brain-queue-text ${long && expanded !== item.id ? 'is-clamped' : ''}`} title="Edit full text" aria-label={`Edit item ${index + 1}`} onClick={() => { setEditing(item.id); setEditText(item.text); }}>{item.text}</button>{long && <button className="brain-queue-expand" aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? undefined : item.id)}>{expanded === item.id ? 'Show less' : 'Show full text'}</button>}</>}</div>
        <div className="brain-queue-actions"><button title="Move up" aria-label={`Move item ${index + 1} up`} disabled={index === 0 || filter !== 'all'} onClick={() => move(index, -1)}><ChevronUp size={14} /></button><button title="Move down" aria-label={`Move item ${index + 1} down`} disabled={index === items.length - 1 || filter !== 'all'} onClick={() => move(index, 1)}><ChevronDown size={14} /></button><button title="Copy full text" aria-label={`Copy item ${index + 1}`} onClick={() => void copy(item)}><Copy size={14} /></button><button title="Delete item" aria-label={`Delete item ${index + 1}`} onClick={() => setConfirm({ description: 'Delete this Brain Queue item?', confirmText: 'Delete', action: () => { if (commit(items.filter(entry => entry.id !== item.id)) && editing === item.id) setEditing(undefined); } })}><Trash2 size={14} /></button></div>
      </article>; })}</div>
      {completed > 0 && <button className="brain-queue-clear" onClick={() => setConfirm({ description: `Clear ${completed} completed item${completed === 1 ? '' : 's'}?`, confirmText: 'Clear completed', action: () => { if (commit(items.filter(item => !item.done))) setEditing(undefined); } })}>Clear completed</button>}
      {items.length >= LIMIT && <p role="status">Queue limit reached ({LIMIT} items).</p>}
      {storageError && <p role="alert">Could not save Brain Queue locally. Try again.</p>}
      {feedback && <p role="status" className="brain-queue-feedback">{feedback}</p>}
    </div>}
    {confirm && <ConfirmDialog title="Confirm Brain Queue change" description={confirm.description} destructive confirmText={confirm.confirmText} onConfirm={() => { confirm.action(); setConfirm(undefined); }} onCancel={() => setConfirm(undefined)} />}
  </section>;
}
