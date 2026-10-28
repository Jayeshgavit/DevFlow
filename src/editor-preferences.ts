export const editorDefaults = { fontSize: 13, lineHeight: 1.6, tabSize: 2, spaces: true, lineNumbers: true, activeLine: true, brackets: true, wrap: 'remember', lastWrap: false };
export type EditorPreferences = typeof editorDefaults;
export function readEditorPreferences(): EditorPreferences {
  try { const p = JSON.parse(localStorage.getItem('devflow-editor-preferences') || '{}'); return { fontSize: Math.max(10, Math.min(24, Number(p.fontSize) || 13)), lineHeight: Math.max(1.2, Math.min(2.4, Number(p.lineHeight) || 1.6)), tabSize: [2, 4, 8].includes(p.tabSize) ? p.tabSize : 2, spaces: p.spaces !== false, lineNumbers: p.lineNumbers !== false, activeLine: p.activeLine !== false, brackets: p.brackets !== false, wrap: ['on', 'off', 'remember'].includes(p.wrap) ? p.wrap : 'remember', lastWrap: p.lastWrap === true }; } catch { return { ...editorDefaults }; }
}
export function saveEditorPreferences(p: EditorPreferences) { localStorage.setItem('devflow-editor-preferences', JSON.stringify(p)); window.dispatchEvent(new Event('devflow-editor-preferences')); }
