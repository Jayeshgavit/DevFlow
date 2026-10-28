import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
export default function ChatStorageSettings() {
  const [location, setLocation] = useState(''); const [candidate, setCandidate] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { void invoke<string>('chat_storage_location').then(setLocation).catch(e => setError(String(e))); }, []);
  const apply = async (migrate: boolean) => { setBusy(true); try { await invoke('chat_storage_apply', { migrate }); setLocation(candidate); setCandidate(''); setError('Storage changed. Reopen DevFlow before continuing chats. Original history was retained at the previous location.'); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <section className="settings-card"><h2>AI Chat Storage</h2><p style={{ overflowWrap: 'anywhere' }}>{location}</p><p>Local history: 100 chats and 8 MiB per project. Limits stop saving; conversations are never automatically deleted. Export and delete older chats explicitly.</p>
    <button className="button" disabled={busy} onClick={() => { void invoke<string | null>('chat_storage_pick').then(path => { if (path) setCandidate(path); }).catch(e => setError(String(e))); }}>Choose local folder</button>
    {candidate && <div role="group" aria-label="Storage migration"><p style={{ overflowWrap: 'anywhere' }}>{candidate}</p><p>Use an empty folder. Git repositories and synchronized folders can expose private conversations. Avoid project source folders. Stop chat activity before switching.</p><button disabled={busy} onClick={() => void apply(true)}>Move Existing History (retain original backup)</button><button disabled={busy} onClick={() => void apply(false)}>Use New Empty Location</button><button disabled={busy} onClick={() => setCandidate('')}>Cancel</button></div>}{error && <p role="status">{error}</p>}
  </section>;
}
