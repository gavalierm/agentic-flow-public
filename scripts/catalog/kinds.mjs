// Triage of a file into a kind by extension (no LLM, no content probes in the scan itself).
export const KINDS = ['text', 'doc', 'pdf_text', 'pdf_scan', 'image', 'csv', 'archive', 'media', 'code', 'symlink', 'binary'];

const BY_EXT = {
  text: ['md', 'txt', 'rst', 'html', 'htm', 'eml', 'json', 'log'],
  doc: ['docx', 'odt', 'rtf', 'pptx', 'xlsx', 'xls', 'ods', 'doc', 'ppt'],
  pdf_text: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'tif', 'tiff', 'bmp'],
  csv: ['csv', 'tsv'],
  archive: ['zip', '7z', 'tar', 'tgz', 'gz'],
  media: ['mp4', 'mov', 'mp3', 'wav', 'm4a'],
  code: ['js', 'mjs', 'ts', 'py', 'sql', 'sh', 'yaml', 'yml', 'toml', 'ini'],
};
const EXT_KIND = new Map();
for (const [kind, exts] of Object.entries(BY_EXT)) for (const e of exts) EXT_KIND.set(e, kind);

export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 && i < name.length - 1 ? name.slice(i + 1).toLowerCase() : '';
}

/** `pdf_text` is the default for a pdf; the profile step moves it to `pdf_scan` when pdftotext finds no text. */
export function kindOf(name) {
  return EXT_KIND.get(extOf(name)) || 'binary';
}
