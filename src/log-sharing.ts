import type { LogEntry } from './log-utils';
import type { Project } from './types';

export type SharedRow = { id: number; entry: LogEntry };
export type SharedFrame = { revision: number; reset: boolean; rows: SharedRow[]; removed: number[]; project?: Project; active: string[]; stopping: string[] };

// IDs follow entry identity, including system/incident lines without source sequences.
export function createLogFrames() {
  const ids = new WeakMap<LogEntry, number>();
  let nextId = 0;
  let revision = 0;
  let previous = new Set<number>();
  return (entries: LogEntry[], reset: boolean, project: Project | undefined, active: string[], stopping: string[]): SharedFrame => {
    const rows = entries.map(entry => {
      let id = ids.get(entry);
      if (id === undefined) { id = ++nextId; ids.set(entry, id); }
      return { id, entry };
    });
    const current = new Set(rows.map(row => row.id));
    const frame = { revision: ++revision, reset, rows: reset ? rows : rows.filter(row => !previous.has(row.id)), removed: reset ? [] : [...previous].filter(id => !current.has(id)), project, active, stopping };
    previous = current;
    return frame;
  };
}

export function applyLogFrame(current: SharedRow[], revision: number, frame: SharedFrame): SharedRow[] | undefined {
  if (!frame.reset && frame.revision !== revision + 1) return undefined;
  if (frame.revision <= revision) return current;
  if (frame.reset) return frame.rows;
  const removed = new Set(frame.removed);
  return [...current.filter(row => !removed.has(row.id)), ...frame.rows];
}
