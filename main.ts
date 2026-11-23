// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write (sections 1 to 4, 9 and 10,
// from the kit's starter), and the three line formats with three-tier matching: unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), matching lines as section 5 says, with the
// move (`R`) lines of section 2. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, for the `R` lines of section 2. */
  readonly moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines (SPEC.md section 3): its own break, whether it ends with one, and the lines between. */
interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { lines, br, finalBreak };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => trimEndST(s.replace(/^[ \t]+/, ''));
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** Line equality at a tier (SPEC.md section 5): exact, trailing blanks off, both sides' blanks off. */
function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trimEndST(a) === trimEndST(b) : trimST(a) === trimST(b);
}

interface Found {
  tier: number;
  positions: number[];
}

/**
 * Every position at or after `from` where O matches the file's lines, at the first tier that has one
 * (SPEC.md section 5). With `eofOnly`, only occurrences that end at the file's last line count (section 8).
 */
function findLines(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): Found | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!lineEq(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a V4A chunk's anchor, at the first tier that has one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

/** One body line of a hunk or chunk: context, old or new text, or the `\` marker that follows one. */
interface Op {
  t: ' ' | '-' | '+' | '\\';
  text: string;
  empty?: boolean;
}

/**
 * The lines a match writes (SPEC.md section 5): context lines are the file's own matched lines, `-` lines
 * drop out, and at tier 2 each `+` line is re-indented, its lead P (O's first line's) replaced by F (the
 * file's first matched line's), when it is not blank and starts with P.
 */
function replacement(lines: string[], pos: number, ops: Op[], o: string[], tier: number): string[] {
  const out: string[] = [];
  const f = leadST(lines[pos] ?? '');
  const p = leadST(o[0] ?? '');
  let k = 0;
  for (const op of ops) {
    if (op.t === ' ') {
      out.push(lines[pos + k]!);
      k += 1;
    } else if (op.t === '-') {
      k += 1;
    } else if (op.t === '+') {
      let s = op.text;
      if (tier === 2 && trimST(s) !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

/** Whether a `\` line follows the last context or `+` line of a body (SPEC.md section 6). */
function noBreakAfter(ops: Op[]): boolean {
  let last = -1;
  ops.forEach((op, i) => {
    if (op.t === ' ' || op.t === '+') last = i;
  });
  return last >= 0 && ops[last + 1]?.t === '\\';
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface UHunk {
  a: number;
  ops: Op[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a `---` or `+++` line names (SPEC.md section 6): to the first tab, spaces off, prefix off. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** One unified section as an edit (SPEC.md section 6): a creation, a deletion, a move or a change. */
function unifiedSection(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
    if (sec.newFile || oldP === null) {
      const target = newP ?? oldP;
      if (target === null || target === undefined) throw new Fail('unsafe', '');
      if (typeof oldP === 'string' && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const all: Op[] = [];
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const op of h.ops) {
          all.push(op);
          if (op.t === '+') plus.push(op.text);
        }
      }
      let last = -1;
      all.forEach((op, i) => {
        if (op.t === '+') last = i;
      });
      const noBreak = last >= 0 && all[last + 1]?.t === '\\';
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (sec.delFile || newP === null) {
      const target = oldP!;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (typeof newP === 'string' && newP !== target && !safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const src = tree.get(oldP);
    if (src === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = splitFile(src);
    let d = 0;
    for (const h of sec.hunks) {
      const ops = h.ops;
      const o = ops.filter((x) => x.t === ' ' || x.t === '-').map((x) => x.text);
      const nLen = ops.filter((x) => x.t === ' ' || x.t === '+').length;
      if (o.length > 0) {
        const found = findLines(model.lines, o, strict, 0, false);
        if (found === null) throw new Fail('no-match', oldP);
        const aim = h.a - 1 + d;
        let pos = found.positions[0]!;
        let best = Math.abs(pos - aim);
        for (const cand of found.positions) {
          const dist = Math.abs(cand - aim);
          if (dist < best) {
            best = dist;
            pos = cand;
          }
        }
        const reachesEnd = pos + o.length === model.lines.length;
        const repl = replacement(model.lines, pos, ops, o, found.tier);
        model.lines.splice(pos, o.length, ...repl);
        if (reachesEnd && ops.length > 0) model.finalBreak = !noBreakAfter(ops);
      } else {
        const at = Math.max(0, Math.min(h.a + d, model.lines.length));
        const atEnd = at === model.lines.length;
        const ins = ops.filter((x) => x.t === '+').map((x) => x.text);
        model.lines.splice(at, 0, ...ins);
        if (atEnd && ops.length > 0) model.finalBreak = !noBreakAfter(ops);
      }
      d += nLen - o.length;
    }
    const text = joinFile(model);
    if (newP !== oldP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

/** Read a unified diff (SPEC.md section 6) into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USection[] = [];
  let cur: USection | null = null;
  const start = (): USection => {
    const s: USection = {
      gitOld: null,
      gitNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    secs.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = start();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.pairOld !== undefined || cur.hunks.length > 0) start();
      cur!.pairOld = headerPath(line);
      cur!.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const ops: Op[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') ops.push({ t: ' ', text: '', empty: true });
        else if (bl[0] === ' ') ops.push({ t: ' ', text: bl.slice(1) });
        else if (bl[0] === '-') ops.push({ t: '-', text: bl.slice(1) });
        else if (bl[0] === '+') ops.push({ t: '+', text: bl.slice(1) });
        else if (bl[0] === '\\') ops.push({ t: '\\', text: '' });
        else break;
        j += 1;
      }
      while (ops.length > 0 && ops[ops.length - 1]!.empty === true) ops.pop();
      cur.hunks.push({ a: Number(m[1]), ops });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return secs.map((s) => unifiedSection(s, strict));
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    let mid = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        mid = j;
        break;
      }
    }
    let end = -1;
    if (mid >= 0) {
      for (let j = mid + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, mid);
    const newLines = lines.slice(mid + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const src = tree.get(p);
      if (src === null) throw new Fail('missing', p);
      const model = splitFile(src);
      const found = findLines(model.lines, oldLines, strict, 0, false);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const ops: Op[] = [
        ...oldLines.map((t): Op => ({ t: '-', text: t })),
        ...newLines.map((t): Op => ({ t: '+', text: t })),
      ];
      const repl = replacement(model.lines, pos, ops, oldLines, found.tier);
      model.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, joinFile(model));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

/** Read a V4A patch (SPEC.md section 8) into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const kindOf = (s: string): 'add' | 'del' | 'upd' | null =>
    s.startsWith('*** Add File:') ? 'add' : s.startsWith('*** Delete File:') ? 'del' : s.startsWith('*** Update File:') ? 'upd' : null;
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = kindOf(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headNo = i + 1;
    const path = line.slice(line.indexOf(':') + 1).trim();
    let j = i + 1;
    const body: { text: string; no: number }[] = [];
    while (j < last && kindOf(lines[j]!) === null) {
      body.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else if (blank(b.text)) fileLines.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
    } else if (kind === 'del') {
      const stray = body.find((b) => !blank(b.text));
      if (stray !== undefined) throw new Exit2(`error: parse ${stray.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      const firstContent = body.findIndex((b) => !blank(b.text));
      if (firstContent >= 0 && body[firstContent]!.text.startsWith('*** Move to:')) {
        moveTo = body[firstContent]!.text.slice('*** Move to:'.length).trim();
        rest = body.slice(firstContent + 1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const b of rest) {
        const bl = b.text;
        if (bl.startsWith('@@')) {
          const a = bl.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, ops: [] };
          chunks.push(cur);
        } else if (bl.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, ops: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          cur = null;
        } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, ops: [] };
            chunks.push(cur);
          }
          if (bl === '') cur.ops.push({ t: ' ', text: '' });
          else cur.ops.push({ t: bl[0] as Op['t'], text: bl.slice(1) });
        } else {
          throw new Exit2(`error: parse ${b.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNo}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const src = tree.get(path);
        if (src === null) throw new Fail('missing', path);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const model = splitFile(src);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const at = findAnchor(model.lines, ch.anchor, strict, cursor);
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          const o = ch.ops.filter((x) => x.t !== '+').map((x) => x.text);
          if (o.length > 0) {
            const found = findLines(model.lines, o, strict, cursor, ch.eof);
            if (found === null) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const repl = replacement(model.lines, pos, ch.ops, o, found.tier);
            model.lines.splice(pos, o.length, ...repl);
            cursor = pos + repl.length;
          } else {
            const ins = ch.ops.filter((x) => x.t === '+').map((x) => x.text);
            const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
            model.lines.splice(at, 0, ...ins);
            cursor = at + ins.length;
          }
        }
        const text = joinFile(model);
        if (moveTo !== null) {
          tree.now.set(path, null);
          tree.now.set(moveTo, text);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, text);
        }
      });
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (consumed.has(o) || consumed.has(nw)) continue;
    if (tree.original(o) !== null && finalOf(o) === null && tree.original(nw) === null && finalOf(nw) !== null) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const [p, now] of tree.now) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const [p, now] of tree.now) {
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
