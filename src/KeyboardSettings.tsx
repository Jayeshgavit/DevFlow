import { useState } from 'react';
import { Button, Card } from './components';
import { bindingError, keyCombination, saveBindings, shortcutDefaults, shortcuts, useBindings } from './shortcuts';

export default function KeyboardSettings() {
  const bindings = useBindings();
  const [recording, setRecording] = useState<string>();
  const [message, setMessage] = useState('');
  const change = (id: string, key: string | null) => {
    const error = bindingError(id, key, bindings);
    if (error) { setMessage(error); return; }
    try { saveBindings({ ...bindings, [id]: key }); setRecording(undefined); setMessage('Shortcut saved.'); }
    catch (cause) { setMessage(String(cause)); }
  };
  return <Card className="settings-card"><h2>Keyboard shortcuts</h2><p>Application-local. Navigation: main window. File tabs: active docked or floating editor. Minimize: current window. Dialogs and native controls take priority.</p>
    <Button onClick={() => { try { saveBindings(shortcutDefaults()); setRecording(undefined); setMessage('Defaults restored.'); } catch (cause) { setMessage(String(cause)); } }}>Restore All Defaults</Button>
    <div className="keyboard-settings">{shortcuts.map(action => <div className="keyboard-setting" key={action.id}><div><strong>{action.name}</strong><p>{action.description}</p><small>{action.scope} · Default: {action.defaultKey}</small></div><kbd>{bindings[action.id] || 'Disabled'}</kbd><div className="toolbar-actions"><Button onClick={() => { setRecording(action.id); setMessage(''); }}>Edit</Button><Button onClick={() => change(action.id, action.defaultKey)}>Reset</Button><Button disabled={bindings[action.id] === null} onClick={() => change(action.id, null)}>Disable</Button></div>
      {recording === action.id && <div className="shortcut-recorder" data-shortcut-recorder><label>Press your shortcut<input autoFocus readOnly aria-label={`Record shortcut for ${action.name}`} placeholder="Press keys…" onKeyDown={event => { event.preventDefault(); event.stopPropagation(); if (event.repeat || event.nativeEvent.isComposing) return; const key = keyCombination(event.nativeEvent); if (!key) { setMessage('Press a supported key with its modifiers.'); return; } change(action.id, key); }} /></label><Button onClick={() => setRecording(undefined)}>Cancel recording</Button><p>Ctrl + E/L/M/P/1–9/comma, optionally Shift; or Ctrl+Shift+F6–F12. An action also accepts its default. Editing and Windows commands are reserved.</p></div>}
    </div>)}</div><p role="status">{message}</p><p>Editor commands remain fixed: Ctrl+S save, Ctrl+F find, Ctrl+H search/replace, Alt+G go to line, and standard copy, paste, selection and undo/redo. Escape remains with CodeMirror and text controls; use the title bar to minimize there.</p>
  </Card>;
}
