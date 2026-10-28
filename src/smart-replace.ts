// Clipboard input is data only. All filesystem access stays in editorApi.
export type ClipboardBlock = { code: string; language: string; path?: string };
export type ReplaceRange = { from: number; to: number; label: string };
export const SMART_LIMIT = 256 * 1024;
export const byteSize = (text: string) => new TextEncoder().encode(text).length;
export function relativeClipboardPath(value: string) {
  const path = value.replace(/^`|`$/g, '');
  if (!path || /[\\:\x00-\x1f<>"|?*]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || /[ .]$/.test(p))) throw new Error('Use an exact project-relative path with forward slashes.');
  return path;
}
function pathLabel(line: string): string | undefined {
  const label = line.trim().replace(/^#{1,6}\s+/, '').replace(/^(?:file|filename|path):\s*/i, '').replace(/:$/, '');
  const unquoted = label.replace(/^`|`$/g, '');
  if (/^[^\s`]+\.[a-z0-9]+$/i.test(unquoted)) return relativeClipboardPath(unquoted);
}
export function parseClipboard(input: string): ClipboardBlock[] {
  if (!input.trim()) throw new Error('Clipboard is empty.');
  if (input.length > SMART_LIMIT || byteSize(input) > SMART_LIMIT) throw new Error('Clipboard exceeds the Smart Replace limit of 256 KiB.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(input)) throw new Error('Clipboard contains binary or invalid text.');
  const lines = input.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) || [];
  const blocks: ClipboardBlock[] = [];
  let lastPath: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/[\r\n]+$/, '');
    const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!fence) { lastPath = pathLabel(line) || (line.trim() ? undefined : lastPath); continue; }
    const info = fence[2].trim().split(/\s+/);
    let language = info[0] || '';
    let path = lastPath;
    if (language.includes('.') || language.includes('/')) { path = relativeClipboardPath(language); language = ''; }
    for (const part of info.slice(1)) {
      const value = part.replace(/^(?:file|filename|path)=/, '').replace(/^"|"$/g, '');
      if (value.includes('.')) path = relativeClipboardPath(value);
    }
    const body: string[] = [];
    let closed = false;
    while (++i < lines.length) {
      const closing = lines[i].replace(/[\r\n]+$/, '');
      if (new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`).test(closing)) { closed = true; break; }
      body.push(lines[i]);
    }
    if (!closed) throw new Error('Unclosed Markdown code fence. Copy a complete block.');
    const code = body.join('');
    if (!code.trim()) throw new Error('A clipboard code block is empty.');
    blocks.push({ code, language, path }); lastPath = undefined;
    if (blocks.length > 20) throw new Error('Choose fewer than 21 code blocks.');
  }
  if (blocks.length) return blocks;
  const first = lines[0]?.replace(/[\r\n]+$/, '') || '';
  const path = pathLabel(first);
  const code = path ? lines.slice(1).join('') : input;
  if (!code.trim()) throw new Error('No source code follows the filename.');
  return [{ code, language: '', path }];
}

// Names are heuristics, never semantic/compiler-grade identity. Parser ranges
// avoid counting braces inside comments, JSX, strings, or template literals.
const declarationName = (text: string) => /^(?:export\s+(?:default\s+)?)?(?:(?:async|pub(?:\([^)]*\))?)\s+)?(?:function\s*\*?\s*|class\s+|(?:const|let|var)\s+|def\s+|fn\s+)([A-Za-z_$][\w$]*)/.exec(text.trim())?.[1];
export const symbolName = (code: string) => declarationName(code);
export async function matchSections(source: string, code: string, path: string): Promise<ReplaceRange[]> {
  const name = declarationName(code);
  if (!name || /^(app|main|index|default|render|test|init)$/i.test(name)) return [];
  const ext = path.split('.').pop()?.toLowerCase();
  const support = /^(ts|tsx|js|jsx|mjs|cjs)$/.test(ext || '')
    ? (await import('@codemirror/lang-javascript')).javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'jsx' || ext === 'tsx' })
    : ext === 'py' ? (await import('@codemirror/lang-python')).python() : undefined;
  if (!support) return [];
  const declarations = new Set(['ExportDeclaration', 'FunctionDeclaration', 'ClassDeclaration', 'VariableDeclaration', 'FunctionDefinition', 'ClassDefinition', 'DecoratedStatement']);
  const ranges = (text: string) => {
    const tree = support.language.parser.parse(text);
    let invalid = false;
    tree.iterate({ enter: node => { if (node.type.isError) invalid = true; } });
    if (invalid) return [];
    const found: ReplaceRange[] = [];
    tree.iterate({ enter: node => {
      if (!declarations.has(node.name)) return;
      // A declaration includes its export/decorator wrapper; never replace both.
      if (node.node.parent && declarations.has(node.node.parent.name)) return;
      const value = text.slice(node.from, node.to);
      if (declarationName(value) !== name) return;
      // Multiple declarators are unsafe: require manual selection instead.
      const variable = node.name === 'VariableDeclaration' ? node.node : node.node.getChild('VariableDeclaration');
      if (variable && variable.getChildren('VariableDefinition').length !== 1) return;
      // Python suites include their terminating line breaks. Keep those bytes
      // outside the replacement so adjacent declarations retain their spacing.
      const to = node.to - (value.match(/[\r\n]+$/)?.[0].length || 0);
      found.push({ from: node.from, to, label: `${name} · parser-delimited declaration` });
    } });
    return found;
  };
  const trimmed = code.trim();
  const incoming = ranges(trimmed);
  if (incoming.length !== 1 || incoming[0].from !== 0 || incoming[0].to !== trimmed.length) return [];
  return ranges(source);
}
export function replacementPreview(source: string, range: ReplaceRange, insertion: string) {
  if (range.from < 0 || range.to < range.from || range.to > source.length) throw new Error('Invalid replacement range.');
  const result = source.slice(0, range.from) + insertion + source.slice(range.to);
  // Exact unified replacement hunk: common prefix/suffix lines are context.
  // Include terminators when comparing so EOF-newline changes are represented,
  // but do not invent a phantom empty line for empty files or a final newline.
  const before = source.match(/[^\n]*\n|[^\n]+$/g) || [], after = result.match(/[^\n]*\n|[^\n]+$/g) || [];
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const removed = before.slice(prefix, before.length - suffix), added = after.slice(prefix, after.length - suffix);
  return { result, removed: removed.length, added: added.length, newlineChanged: source.endsWith('\n') !== result.endsWith('\n'),
    first: source.slice(0, range.from).split('\n').length,
    last: source.slice(0, Math.max(range.from, range.to - 1)).split('\n').length,
    lines: [...before.slice(Math.max(0, prefix - 3), prefix).map(text => ({ kind: 'context', text })), ...removed.map(text => ({ kind: 'remove', text })), ...added.map(text => ({ kind: 'add', text })), ...before.slice(before.length - suffix, before.length - suffix + 3).map(text => ({ kind: 'context', text }))],
  };
}
