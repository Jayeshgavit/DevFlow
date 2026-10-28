import React, { useState } from 'react';
import { editorDefaults, readEditorPreferences, saveEditorPreferences, type EditorPreferences as Preferences } from './editor-preferences';
export default function EditorPreferences() {
  const [value, setValue] = useState(readEditorPreferences);
  const [error, setError] = useState('');
  const update = (patch: Partial<Preferences>) => { const next = { ...value, ...patch }; try { saveEditorPreferences(next); setValue(next); setError(''); } catch { setError('Preferences could not be saved.'); } };
  return <section className="settings-card"><h2>Editor Preferences</h2>
    <label className="setting-row">Word wrap<select value={value.wrap} onChange={e => update({ wrap: e.target.value })}><option value="on">Always On</option><option value="off">Always Off</option><option value="remember">Remember Last Used</option></select></label>
    <label className="setting-row">Font size<input type="number" min="10" max="24" value={value.fontSize} onChange={e => update({ fontSize: Math.max(10, Math.min(24, Number(e.target.value) || 13)) })} /></label>
    <label className="setting-row">Line height<input type="number" min="1.2" max="2.4" step="0.1" value={value.lineHeight} onChange={e => update({ lineHeight: Math.max(1.2, Math.min(2.4, Number(e.target.value) || 1.6)) })} /></label>
    <label className="setting-row">Tab size<select value={value.tabSize} onChange={e => update({ tabSize: Number(e.target.value) })}>{[2,4,8].map(n => <option key={n}>{n}</option>)}</select></label>
    {(['spaces', 'lineNumbers', 'activeLine', 'brackets'] as const).map(key => <label className="setting-row" key={key}>{({ spaces: 'Insert spaces', lineNumbers: 'Line numbers', activeLine: 'Highlight active line', brackets: 'Bracket matching' })[key]}<input type="checkbox" checked={value[key]} onChange={e => update({ [key]: e.target.checked })} /></label>)}
    <button className="button" onClick={() => update({ ...editorDefaults })}>Restore editor defaults</button>{error && <p role="alert">{error}</p>}
  </section>;
}
