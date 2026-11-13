// Secret detection (P-018, P-052): a secret belongs to local/ (gitignored, never shared), not to scratch/ or tracked files.

/** Token formats of known providers and private keys. */
// Built from pieces so the pattern itself does not look like a token to secret scanners (public snapshot gate).
// A private key is its PEM header with a key body after it (a newline, also JSON-escaped, then base64): the header alone
// is the format a check names (startswith), no key (report-123b3205: a format check of a key file was denied as a token).
const TOKEN_RE = new RegExp([
  String.raw`\b(ghp_[A-Za-z0-9]{20,}`, 'github' + String.raw`_pat_[A-Za-z0-9_]{20,}`, String.raw`gh[ousr]_[A-Za-z0-9]{20,}`,
  String.raw`sk-(ant-)?[A-Za-z0-9_-]{20,}`, 'xo' + String.raw`x[bap]-[A-Za-z0-9-]{10,}`, String.raw`AKIA[0-9A-Z]{16})\b`,
].join('|') + String.raw`|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----(\s|\\[rn])+[A-Za-z0-9+/=]{40,}`);

/** `password|token|secret|api_key = "value"` with a literal value that is not a placeholder. */
const ASSIGN_RE = /(password|passwd|token|secret|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi;
const PLACEHOLDER_RE = /^(x+|\*+|\.+|<.*>|\$.*|\{.*\}|changeme|example.*|dummy.*|test.*|fake.*|your.*)$/i;

/** Kind of the first secret in text, or null. */
export function findSecret(text) {
  const s = String(text || '');
  const t = TOKEN_RE.exec(s);
  if (t) return 'token';
  for (const m of s.matchAll(ASSIGN_RE)) if (!PLACEHOLDER_RE.test(m[2])) return `${m[1].toLowerCase()} value`;
  return null;
}
