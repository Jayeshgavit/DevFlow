import { byteSize, parseClipboard, relativeClipboardPath, SMART_LIMIT, type ClipboardBlock } from './smart-replace';

export function newFilePath(value: string) {
  const path = relativeClipboardPath(value.replace(/\\/g, '/'));
  if (path.length > 1024 || path.split('/').length > 24 || path.split('/').some(part => part.length > 255 || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]+|LPT[0-9¹²³]+) *$/i.test(part.split('.')[0]))) throw new Error('Choose a valid Windows project-relative filename.');
  return path;
}
function label(line: string) {
  const text = line.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '').replace(/^\*\*(.*?)\*\*$/, '$1');
  const explicit = /^(?:file|filename|path):\s*(.+)$/i.exec(text);
  const value = (explicit?.[1] || text).replace(/^`|`$/g, '');
  if (explicit || /^[^\s`]+\.[a-z0-9]+$/i.test(value)) return newFilePath(value);
}
// Reuse A5's bounded fence/content parser, while retaining Copy for AI's
// FILE/NAME/LANGUAGE/CONTENT metadata and accepting Windows path separators.
export function parseNewFiles(input: string): ClipboardBlock[] {
  if (!input.trim()) throw new Error('Clipboard is empty. Copy source code first.');
  if (byteSize(input) > SMART_LIMIT) throw new Error('Clipboard exceeds 256 KiB.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(input)) throw new Error('Clipboard contains binary or invalid text.');
  const lines = input.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
  const blocks: ClipboardBlock[] = [];
  let path: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[\r\n]+$/, '');
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (/^(?:NAME|LANGUAGE|CONTENT|Lines):/i.test(line.trim()) || !line.trim()) continue;
      path = label(line); continue;
    }
    const start = i;
    while (++i < lines.length && !new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[i].replace(/[\r\n]+$/, ''))) { /* Preserve source bytes. */ }
    if (i === lines.length) throw new Error('Unclosed Markdown code fence. Copy a complete block.');
    const info = fence[2].trim().split(/\s+/);
    let language = info[0] || '';
    let inline: string | undefined;
    if (/[.\/\\]/.test(language)) { inline = newFilePath(language); language = ''; }
    for (const part of info.slice(1)) { const value = part.replace(/^(?:file|filename|path)=/i, '').replace(/^"|"$/g, ''); if (/[.\/\\]/.test(value)) inline = newFilePath(value); }
    if (inline && path && inline !== path) throw new Error('Conflicting filenames on one code block. Copy it with a single clear filename.');
    const segment = `${fence[1]}${language}\n${lines.slice(start + 1, i + 1).join('')}`;
    const block = parseClipboard(segment)[0];
    blocks.push({ ...block, path: inline || path }); path = undefined;
    if (blocks.length > 20) throw new Error('Copy at most 20 code blocks.');
  }
  if (blocks.length) return blocks;
  const labels = lines.flatMap((line, index) => /^(?:\s*#{1,6}\s+|\s*(?:file|filename|path):)/i.test(line) && label(line.replace(/[\r\n]+$/, '')) ? [index] : []);
  if (labels.length > 1) throw new Error('Multiple unfenced file labels are ambiguous. Copy each file in a separate labeled code fence.');
  const first = label(lines[0]?.replace(/[\r\n]+$/, '') || '');
  const code = first ? lines.slice(1).join('') : input;
  return [{ ...parseClipboard(code)[0], path: first }];
}

export type NewFileChoice = { selected: boolean; name: string; folder: string; resolution: '' | 'clipboard' | 'folder'; done?: boolean };
export function destination(block: ClipboardBlock, choice: NewFileChoice) {
  const name = newFilePath(choice.name);
  const folder = choice.folder ? newFilePath(choice.folder) : '';
  const explicit = !!block.path;
  const conflict = explicit && !!folder && name.split('/').slice(0, -1).join('/').toLowerCase() !== folder.toLowerCase();
  if (conflict && !choice.resolution) throw new Error('Choose the clipboard path or the selected folder explicitly.');
  return newFilePath(explicit && choice.resolution !== 'folder' ? name : [folder, explicit ? name.split('/').pop() : name].filter(Boolean).join('/'));
}
