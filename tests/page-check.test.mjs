// keep: guarded
// Operator 2026-11-22: "uprav flow, aby diagramy boli WCAG (kontrast pre čitateľnosť)"; a page with a problem is not
// shown (P-077). The check reads the page's own CSS in the light and the dark form; the status map template is drawn by
// a script, so its colours are measured here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { checkPage, contrast, parseColor } from '../scripts/page-check.mjs';

const page = (vars, dark, body) => `<!doctype html><html><head><style>
:root{--bg:#f4f6f9;--surface:#fff;--fg:#18202c;${vars}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f141b;--surface:#171e28;--fg:#e6ebf2;${dark}}}
body{background:var(--bg);color:var(--fg);font-size:15px}
.card{background:var(--surface)} .muted{color:var(--muted)} .chip{background:var(--soft);color:var(--tone);font-size:12px}
.card li::after{content:"detail";font-size:var(--after,12px);color:var(--muted)}
svg .box{fill:var(--surface)} svg .lbl{fill:var(--muted);font-size:var(--lbl,12px)} svg .e{fill:none;stroke:var(--edge);stroke-width:2} svg .grid{stroke:#e3e6ea}
</style></head><body>${body}</body></html>`;
const BODY = `<div class="card"><p class="muted">vedľajší text</p><b class="chip">D</b><ul><li>riadok</li></ul>
<svg viewBox="0 0 720 200"><rect x="10" y="10" width="300" height="80" class="box"/><text x="20" y="40" class="lbl">popis</text><path d="M20 150 L300 150" class="e"/><line x1="0" y1="190" x2="720" y2="190" class="grid"/></svg></div>`;
const GOOD = ['--muted:#5b6678;--soft:#e3ecfb;--tone:#2563c9;--edge:#5b6678', '--muted:#94a0b3;--soft:#1a2a45;--tone:#6b9cf0;--edge:#94a0b3'];

test('a page is measured as the browser shows it: text, drawing text on its shape, lines, sizes, light and dark', () => {
  assert.deepEqual(checkPage(page(...GOOD, BODY)).problems, []);
  const lines = (vars, dark, body = BODY) => checkPage(page(vars, dark, body)).problems.map((p) => p.line);
  // an orange label on its pale ground, a grey line and a grey drawing label: the page of 2026-11-22
  // (one line per pair of colours: the side text, the text a rule adds and the drawing label are the same pair, 3 places)
  const bad = checkPage(page('--muted:#9aa4b2;--soft:#fbeedd;--tone:#c46a0a;--edge:#9aa4b2', GOOD[1], BODY)).problems;
  assert.deepEqual(bad.map((p) => `${p.line} x${p.count}`), [
    'light: text "vedľajší text" #9aa4b2 on #ffffff is 2.5 : 1, needs 4.5 : 1 (p.muted) x3',
    'light: text "D" #c46a0a on #fbeedd is 3.3 : 1, needs 4.5 : 1 (b.chip) x1',
    'light: line "path.e" #9aa4b2 on #ffffff is 2.5 : 1, needs 3 : 1 (drawing, path.e) x1',
  ]);
  // the label of a drawing is measured against the shape under it, not against the page
  let got = lines(GOOD[0], GOOD[1], BODY.replace('class="box"', 'class="box" style="fill:#5b6678"'));
  assert.deepEqual(got.map((l) => l.replace(/ is [\d.]+ : 1/, '')), ['light: text "popis" #5b6678 on #5b6678, needs 4.5 : 1 (drawing, text.lbl)', 'dark: text "popis" #94a0b3 on #5b6678, needs 4.5 : 1 (drawing, text.lbl)']);
  // the dark form alone
  got = lines(GOOD[0], '--muted:#5d6879;--soft:#1a2a45;--tone:#6b9cf0;--edge:#94a0b3');
  assert.ok(got.length && got.every((l) => l.startsWith('dark:')), got.join('\n'));
  // sizes: text of the page, and text of a drawing that shrinks in a page column
  got = lines(`${GOOD[0]};--after:10.5px`, GOOD[1]);
  assert.deepEqual(got, ['text "detail" is 10.5 px, needs 12 px (li::after)']);
  got = lines(GOOD[0], GOOD[1], BODY.replace('0 0 720 200', '0 0 960 200'));
  assert.match(got.join('\n'), /^text "popis" in the drawing is 9\.0 px at a page column of 720 px \(font-size 12 in a viewBox 960 wide\), needs 11 px/);
  // a hairline (the grid above) is decoration; what is hidden is not measured; a colour form that is not known is not judged
  assert.match(checkPage('<style>@media (prefers-color-scheme:dark){h1{color:#e9ede6}}</style><h1>Nadpis</h1>').problems[0].line, /^dark: text "Nadpis" #e9ede6 on #ffffff is 1\.1 : 1, needs 3 : 1/);
  assert.deepEqual(lines(`${GOOD[0]}`, GOOD[1], `${BODY}<p hidden style="color:#eee">skryté</p><p style="color:color-mix(in srgb, red, blue)">x</p>`), []);
});

test('a page with a problem is not shown: the refusal names the colours; a readable page passes', () => {
  const fx = setup({ thread: 'a1' });
  try {
    const bad = path.join(fx.project, 'navrh-zly.html');
    const good = path.join(fx.project, 'navrh-dobry.html');
    fs.writeFileSync(bad, page('--muted:#9aa4b2;--soft:#fbeedd;--tone:#c46a0a;--edge:#9aa4b2', GOOD[1], BODY));
    fs.writeFileSync(good, page(...GOOD, BODY));
    const show = (file, tool_name = 'Artifact') => fx.hook('pre-tool-use.mjs', { tool_name, tool_input: tool_name === 'Artifact' ? { file_path: file, icon: 'map' } : { path: file } }).json.hookSpecificOutput;
    for (const tool of ['Artifact', 'mcp__t3-code__html_preview']) {
      const out = show(bad, tool);
      assert.equal(out?.permissionDecision, 'deny', tool);
      assert.match(out.permissionDecisionReason, /not readable for the operator \(P-077[\s\S]*\n- light: text "D" #c46a0a on #fbeedd[\s\S]*page-check\.mjs/);
    }
    assert.doesNotMatch(String(show(good)?.permissionDecisionReason || ''), /not readable/);
    const cli = fx.run('page-check.mjs', [bad, good]);
    assert.equal(cli.status, 1);
    assert.match(cli.out, /navrh-zly\.html: \d+ problem\(s\)[\s\S]*navrh-dobry\.html: readable/);
  } finally { fx.cleanup(); }
});

test('the colours and sizes of the status map template are readable', () => {
  const css = fs.readFileSync(new URL('../templates/status-map.html', import.meta.url), 'utf8');
  const [light, dark] = [css.split('@media (prefers-color-scheme: dark)')[0], css.split('@media (prefers-color-scheme: dark)')[1].split('}')[0]];
  for (const [name, block] of [['light', light], ['dark', dark]]) {
    const v = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], parseColor(m[2])]));
    const text = [['done', 'done-bg'], ['work', 'work-bg'], ['wait', 'wait-bg'], ['miss', 'miss-bg'], ['off', 'off-bg'], ['miss', 'panel'], ['muted', 'bg'], ['muted', 'panel'], ['fg', 'panel'], ['fg', 'bg'], ['root-fg', 'root']];
    for (const [fg, bg] of text) assert.ok(contrast(v[fg], v[bg]) >= 4.5, `${name}: ${fg} on ${bg} is ${contrast(v[fg], v[bg]).toFixed(2)}`);
    assert.ok(contrast(v.branch, v.bg) >= 3, `${name}: the wires are ${contrast(v.branch, v.bg).toFixed(2)}`);
  }
  assert.equal([...css.matchAll(/font-size:\s*([\d.]+)px/g)].filter((m) => Number(m[1]) < 12).length, 0, 'no text under 12 px');
});
