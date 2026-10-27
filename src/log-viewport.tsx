import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogGroup } from './log-utils';

interface Bookmark { entry: LogEntry; inset: number }
const rowKeys = new WeakMap<LogEntry, number>();
let nextRowKey = 0;
function rowKey(entry: LogEntry) {
  if (!rowKeys.has(entry)) rowKeys.set(entry, ++nextRowKey);
  return rowKeys.get(entry);
}

// Measured heights keep wrapped lines and expanded stacks in the same scroll model.
export function LogViewport({ groups, scope, follow, onPause, fontSize, wrap, layoutKey, target, targetRequest, renderRow, empty, onVisible }: {
  groups: LogGroup[]; scope: string; follow: boolean; onPause: () => void;
  fontSize: number; wrap: boolean; layoutKey?: string; target: LogEntry | null; targetRequest?: number;
  renderRow: (group: LogGroup) => React.ReactNode; empty: React.ReactNode;
  onVisible: (groups: LogGroup[]) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const heights = useRef(new WeakMap<LogEntry, number>());
  const bookmarks = useRef(new Map<string, Bookmark>());
  const bookmark = useRef<Bookmark | null>(null);
  const previousScope = useRef(scope);
  const previousTarget = useRef(target);
  const previousRequest = useRef(targetRequest);
  const userScrolling = useRef(false);
  const [position, setPosition] = useState({ top: 0, height: 600, width: 0 });
  const [revision, setRevision] = useState(0);
  const offsets = useMemo(() => {
    const result = [0];
    for (const group of groups) result.push(result[result.length - 1] + (heights.current.get(group.entries[0]) ?? Math.ceil(fontSize * 1.65 + 12)));
    return result;
  }, [groups, fontSize, revision]);
  const indexAt = (top: number) => {
    let low = 0, high = groups.length;
    while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid + 1] <= top) low = mid + 1; else high = mid; }
    return Math.min(low, Math.max(0, groups.length - 1));
  };
  const first = indexAt(position.top);
  const last = indexAt(position.top + position.height);
  const start = Math.max(0, first - 8);
  const end = Math.min(groups.length, last + 9);
  const measure = useCallback((entry: LogEntry, height: number) => {
    if (height > 0 && heights.current.get(entry) !== height) {
      heights.current.set(entry, height);
      setRevision(value => value + 1);
    }
  }, []);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!element.clientWidth || !element.clientHeight) return; // hidden tab
      heights.current = new WeakMap();
      setRevision(value => value + 1);
      setPosition({ top: element.scrollTop, height: element.clientHeight, width: element.clientWidth });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { heights.current = new WeakMap(); setRevision(value => value + 1); }, [fontSize, wrap, layoutKey]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !element.clientHeight) return;
    const scopeChanged = previousScope.current !== scope;
    const targetChanged = (previousTarget.current !== target || previousRequest.current !== targetRequest) && target;
    let saved = bookmark.current;
    if (scopeChanged) {
      if (saved) {
        bookmarks.current.set(previousScope.current, saved);
        if (bookmarks.current.size > 80) bookmarks.current.delete(bookmarks.current.keys().next().value!);
      }
      // Never carry an anchor from a different project into its output.
      saved = bookmarks.current.get(scope) ?? (saved?.entry.projectId === groups[0]?.entries[0].projectId ? saved : null);
      bookmark.current = saved;
      previousScope.current = scope;
    }
    previousTarget.current = target;
    previousRequest.current = targetRequest;
    if (targetChanged) {
      const index = groups.findIndex(group => group.entries.includes(target));
      if (index >= 0) element.scrollTop = offsets[index];
    } else if (follow) element.scrollTop = element.scrollHeight;
    else if (saved && groups.length) {
      let index = groups.findIndex(group => group.entries.includes(saved.entry));
      if (index < 0) index = groups.findIndex(group => group.entries[0].receivedAt >= saved.entry.receivedAt);
      element.scrollTop = offsets[index < 0 ? groups.length - 1 : index] + saved.inset;
    } else if (scopeChanged) element.scrollTop = 0;
    const index = indexAt(element.scrollTop);
    if (groups[index]) bookmark.current = { entry: groups[index].entries[0], inset: element.scrollTop - offsets[index] };
    setPosition(current => current.top === element.scrollTop ? current : { ...current, top: element.scrollTop });
  }, [groups, offsets, scope, follow, target, targetRequest, position.height, position.width]);
  useLayoutEffect(() => { onVisible(groups.slice(first, last + 1)); }, [groups, first, last, onVisible]);
  useLayoutEffect(() => {
    if (target) viewport.current?.querySelector<HTMLElement>('.is-targeted')?.focus({ preventScroll: true });
  }, [target, targetRequest, start, end]);

  return <div ref={viewport} className={`log-viewport console-viewport${wrap ? ' console-wrap' : ' console-nowrap'}`} style={{ '--console-font-size': `${fontSize}px` } as React.CSSProperties}
    tabIndex={0} role="log" aria-label="Service output" aria-live="off"
    onWheel={() => { userScrolling.current = true; }} onTouchMove={() => { userScrolling.current = true; }} onPointerDown={() => { userScrolling.current = true; }}
    onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScrolling.current = true; }}
    onScroll={event => {
      const element = event.currentTarget;
      const index = indexAt(element.scrollTop);
      if (groups[index]) bookmark.current = { entry: groups[index].entries[0], inset: element.scrollTop - offsets[index] };
      if (userScrolling.current) {
        if (follow && element.scrollHeight - element.scrollTop - element.clientHeight > 36) onPause();
        userScrolling.current = false;
      }
      setPosition(current => ({ ...current, top: element.scrollTop }));
    }}>
    {!groups.length ? empty : <>
      <div aria-hidden="true" style={{ height: offsets[start] }} />
      {groups.slice(start, end).map(group => <MeasuredRow key={rowKey(group.entries[0])} entry={group.entries[0]} measure={measure}>{renderRow(group)}</MeasuredRow>)}
      <div aria-hidden="true" style={{ height: offsets[groups.length] - offsets[end] }} />
    </>}
  </div>;
}

function MeasuredRow({ entry, measure, children }: { entry: LogEntry; measure: (entry: LogEntry, height: number) => void; children: React.ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (row.current) measure(entry, row.current.getBoundingClientRect().height); });
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const observer = new ResizeObserver(() => measure(entry, element.getBoundingClientRect().height));
    observer.observe(element);
    measure(entry, element.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [entry, measure]);
  return <div ref={row}>{children}</div>;
}
