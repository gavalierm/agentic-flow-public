// One shell tokenizer for the hooks (hooks review 2026-11-08, C3). The regex checks split the command text at operators
// and spaces, so a quoted `;`, a `-o` inside a regex or a heredoc body read as commands, and every false positive was
// fixed by one more exception (agentic-flow-public#11, #16). This parser follows POSIX shell quoting closely enough
// for the checks: it never executes or expands anything, it only says which words are literal.
//
//   parse(command) -> [{ words: [Word], redirects: [{ op, fd, target: Word|null }], sub: boolean }]
//   Word = { text, raw, quoted, dynamic }   text: the value after quote removal; dynamic: contains $, `, $( ) or an
//   unquoted glob, so its value is not known before the shell runs it.
// Segments end at ; & && || | newline ( ) ; a heredoc body is data, not a segment; $( ) and backticks are parsed as
// segments of their own (sub: true) after the outer ones.

const OPS = ['&&', '||', ';;', '|&', ';', '&', '|', '(', ')'];
const REDIR = ['&>>', '&>', '>>', '>|', '<<<', '<<-', '<<', '<>', '<&', '>&', '>', '<'];

/** Index after the matching close of $( at i (i points just after "$("), quotes inside respected. */
function closeParen(s, i) {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
      i++; continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
    i++;
  }
  return s.length;
}

export function parse(command, { sub = false } = {}) {
  const s = String(command ?? '');
  const segs = [];
  const subs = [];
  let seg = { words: [], redirects: [], sub };
  let word = null;
  let redirect = null; // a redirect waiting for its target word
  const heredocs = []; // delimiters whose bodies start after the next newline
  const start = () => { if (!word) word = { text: '', raw: '', quoted: false, dynamic: false }; };
  const endWord = () => {
    if (!word) return;
    if (redirect) {
      redirect.target = word;
      if (redirect.op === '<<' || redirect.op === '<<-') heredocs.push({ delim: word.text, strip: redirect.op === '<<-' });
      seg.redirects.push(redirect);
      redirect = null;
    } else seg.words.push(word);
    word = null;
  };
  const endSeg = () => {
    endWord();
    if (redirect) { seg.redirects.push(redirect); redirect = null; }
    if (seg.words.length || seg.redirects.length) segs.push(seg);
    seg = { words: [], redirects: [], sub };
  };
  const skipHeredocs = (i) => {
    // i is just after a newline: consume the body of each pending heredoc, line by line
    while (heredocs.length) {
      const { delim, strip } = heredocs.shift();
      for (;;) {
        if (i >= s.length) return s.length;
        let j = s.indexOf('\n', i);
        if (j < 0) j = s.length;
        const line = strip ? s.slice(i, j).replace(/^\t+/, '') : s.slice(i, j);
        i = j + 1;
        if (line === delim) break;
      }
    }
    return i;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { i += 2; continue; }
      start(); word.text += s[i + 1] ?? ''; word.raw += s.slice(i, i + 2); word.quoted = true; i += 2; continue;
    }
    if (c === "'") {
      start();
      let j = s.indexOf("'", i + 1);
      if (j < 0) j = s.length;
      word.text += s.slice(i + 1, j); word.raw += s.slice(i, j + 1); word.quoted = true; i = j + 1; continue;
    }
    if (c === '"') {
      start(); word.quoted = true;
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && '$`"\\\n'.includes(s[j + 1])) { word.text += s[j + 1]; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { const k = closeParen(s, j + 2); subs.push(s.slice(j + 2, k - 1)); word.text += s.slice(j, k); word.dynamic = true; j = k; continue; }
        if (s[j] === '`') { let k = s.indexOf('`', j + 1); if (k < 0) k = s.length; subs.push(s.slice(j + 1, k)); word.text += s.slice(j, k + 1); word.dynamic = true; j = k + 1; continue; }
        if (s[j] === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(s[j + 1] || '')) word.dynamic = true;
        word.text += s[j]; j++;
      }
      word.raw += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      start();
      const k = closeParen(s, i + 2);
      subs.push(s.slice(i + 2, k - 1));
      word.text += s.slice(i, k); word.raw += s.slice(i, k); word.dynamic = true; i = k; continue;
    }
    if (c === '`') {
      start();
      let k = s.indexOf('`', i + 1);
      if (k < 0) k = s.length;
      subs.push(s.slice(i + 1, k));
      word.text += s.slice(i, k + 1); word.raw += s.slice(i, k + 1); word.dynamic = true; i = k + 1; continue;
    }
    if (c === '#' && !word) { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue; }
    if (c === '\n') { endSeg(); i = skipHeredocs(i + 1); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    // a redirect: an optional fd made of digits only (`2>`), then the operator
    const redir = REDIR.find((op) => s.startsWith(op, i));
    if (redir) {
      let fd = null;
      if (word && !word.quoted && /^[0-9]+$/.test(word.raw)) { fd = Number(word.raw); word = null; } else endWord();
      if (redirect) { seg.redirects.push(redirect); redirect = null; }
      i += redir.length;
      // `>&2`, `2>&1`, `<&-`: a duplication, no file
      if ((redir === '>&' || redir === '<&') && /[0-9-]/.test(s[i] || '')) {
        const m = s.slice(i).match(/^[0-9]+-?|^-/);
        seg.redirects.push({ op: redir, fd, target: null, dup: m[0] });
        i += m[0].length; continue;
      }
      redirect = { op: redir === '>&' ? '>' : redir, fd, target: null };
      continue;
    }
    // `(` opens a subshell only where a command starts; inside a command (`a=(x y)`, PowerShell `-Path (expr)`) the
    // parenthesised text is one word
    if (c === '(' && (word || seg.words.length)) {
      start();
      const k = closeParen(s, i + 1);
      word.text += s.slice(i, k); word.raw += s.slice(i, k); i = k; continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (op) { endSeg(); i += op.length; continue; }
    start();
    if (/[*?[]/.test(c)) word.dynamic = true;
    if (c === '$' && /[A-Za-z_{0-9@*#?$!-]/.test(s[i + 1] || '')) word.dynamic = true;
    word.text += c; word.raw += c; i++;
  }
  endSeg();
  for (const inner of subs) segs.push(...parse(inner, { sub: true }));
  return segs;
}

/** NAME=value words before the program (env prefix) and shell keywords that precede the program. */
const LEAD_WORDS = new Set(['sudo', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', 'nohup', 'command', 'exec', '!', '{', 'env']);
export function programIndex(words) {
  let i = 0;
  while (i < words.length - 1 && (LEAD_WORDS.has(words[i].text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].text))) i++;
  return i;
}
