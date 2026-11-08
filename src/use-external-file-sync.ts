import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { editorApi, normalizeText } from './editor-api';
import { tabDirty, tabKey, type EditorTab } from './editor-session';
import { readEditorPreferences } from './editor-preferences';
import type { Project } from './types';

type Change = { generation: string; lease: number; paths: string[]; failed: boolean };
type Options = { project?: Project; lease?: number; tabs: EditorTab[]; setTabs: Dispatch<SetStateAction<EditorTab[]>>; blocked: boolean; blockedNow: () => boolean; refresh: (parents: Set<string>) => void; error: (message: string) => void };

// The native watcher is advisory. Every read still passes through editor_read;
// every save still compares exact disk bytes under the writer lease.
export function useExternalFileSync(options: Options) {
  const current = useRef(options); current.current = options;
  const [mode, setMode] = useState(() => readEditorPreferences().externalChanges);
  const operations = useRef(Promise.resolve());
  const resume = useRef<() => void>();
  useEffect(() => {
    const apply = () => setMode(readEditorPreferences().externalChanges);
    window.addEventListener('storage', apply); window.addEventListener('devflow-editor-preferences', apply);
    return () => { window.removeEventListener('storage', apply); window.removeEventListener('devflow-editor-preferences', apply); };
  }, []);
  const identity = JSON.stringify(options.tabs.map(tab => tab.path).sort());
  useEffect(() => {
    const { project, lease } = current.current;
    if (!project || lease === undefined || mode === 'manual' || !current.current.tabs.length) return;
    const generation = `${getCurrentWindow().label}:${lease}:${crypto.randomUUID()}`;
    const paths = current.current.tabs.map(tab => tab.path);
    const allowed = new Set(paths.map(tabKey));
    let disposed = false, reading = false, revision = 0;
    let stop: (() => void) | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set(paths);
    const valid = () => !disposed && current.current.project?.id === project.id && current.current.project?.root === project.root && current.current.lease === lease && !current.current.blockedNow();
    const pump = async () => {
      if (reading || !valid() || current.current.blocked) return;
      reading = true;
      try {
        while (pending.size && valid() && !current.current.blocked) {
          const batch = [...pending]; pending.clear();
          const baselines = new Map(current.current.tabs.map(tab => [tabKey(tab.path), tab.document]));
          const readRevision = revision;
          const results = await Promise.all(batch.map(async path => {
            for (let attempt = 0; ; attempt++) {
              try { return { path, document: await editorApi.read(project, path) }; }
              catch { if (attempt === 3 || disposed) return { path, document: undefined }; await new Promise(resolve => setTimeout(resolve, [80, 220, 500][attempt])); }
            }
          }));
          if (!valid()) { batch.forEach(path => pending.add(path)); break; }
          // A handoff can complete before React sees the new lease.
          if (await editorApi.lease() !== lease || !valid()) break;
          if (readRevision !== revision) { batch.forEach(path => pending.add(path)); continue; }
          if (current.current.blocked) { batch.forEach(path => pending.add(path)); break; }
          current.current.setTabs(tabs => tabs.map(tab => {
            const result = results.find(result => tabKey(result.path) === tabKey(tab.path));
            if (!result) return tab;
            // A save/reload/reopened tab may have advanced its disk baseline
            // while this read was in flight, even before its native event arrives.
            if (tab.document !== baselines.get(tabKey(tab.path))) { pending.add(tab.path); return tab; }
            const disk = result.document;
            if (!disk) return tab.external === 'missing' ? tab : { ...tab, external: 'missing', externalDismissed: false, updatedFromDisk: false };
            if (disk.content === tab.document.content) return tab.external ? { ...tab, external: undefined, externalDismissed: false } : tab;
            if (tabDirty(tab) || mode !== 'auto') return { ...tab, external: 'changed', externalDismissed: tab.external === 'changed' && tab.externalDismissed, updatedFromDisk: false };
            const text = normalizeText(disk.content);
            return { ...tab, document: disk, baseline: text, text, editing: tab.editing && !disk.readOnly && disk.lineEnding !== 'mixed', external: undefined, externalDismissed: false, updatedFromDisk: true, syncRevision: (tab.syncRevision || 0) + 1 };
          }));
          current.current.refresh(new Set(batch.map(path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')));
        }
      } catch (cause) { if (!disposed) current.current.error(`External file check unavailable: ${String(cause)}. Reload Disk Version remains available.`); }
      finally { reading = false; }
    };
    resume.current = () => { void pump(); };
    // Serialize registration/cleanup even when project or tabs change quickly.
    operations.current = operations.current.catch(() => {}).then(async () => {
      if (disposed) return;
      stop = await listen<Change>('editor-files-changed', event => {
        if (disposed || event.payload.generation !== generation || event.payload.lease !== lease) return;
        event.payload.paths.filter(path => allowed.has(tabKey(path))).forEach(path => pending.add(path));
        revision++;
        if (event.payload.failed) current.current.error('External file monitoring stopped. Reopen a tab or change External File Changes settings to retry. Manual reload remains available.');
        // One queued event batch; continuous native bursts cannot create parallel reads.
        if (retry) clearTimeout(retry);
        retry = setTimeout(() => { void pump(); }, 30);
      }, { target: getCurrentWindow().label });
      if (disposed) { stop(); return; }
      await editorApi.watch(project, paths, lease, generation);
      if (!disposed) void pump(); // Covers writes during window handoff/registration.
    }).catch(cause => { if (!disposed) current.current.error(`External file monitoring unavailable: ${String(cause)}`); });
    return () => {
      disposed = true; resume.current = undefined; stop?.(); if (retry) clearTimeout(retry);
      operations.current = operations.current.catch(() => {}).then(() => editorApi.unwatch(lease, generation)).catch(() => { /* Old owners cannot unregister the new owner's watcher. */ });
    };
  }, [options.project?.id, options.project?.root, options.lease, identity, mode]);
  useEffect(() => { if (!options.blocked) resume.current?.(); }, [options.blocked]);
}
