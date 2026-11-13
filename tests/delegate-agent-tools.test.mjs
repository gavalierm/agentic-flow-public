import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './helpers.mjs';

// report-dd4ad700: a brief for an agent type without Bash asked it to save raw API responses into scratch/;
// another agent skipped a paid data source because the brief named no budget.
test('prepare --agent refuses a brief that needs file writes for a type without Write, Edit and Bash; a paid source needs a budget (report-dd4ad700)', () => {
  const fx = setup();
  try {
    const dir = path.join(fx.project, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reader.md'), '---\nname: reader\ntools: Read, Grep, WebFetch  # Write not needed\n---\nbody\n');
    fs.writeFileSync(path.join(dir, 'writer.md'), '---\nname: writer\ntools:\n  - Read\n  - Write\n---\nbody\n');
    const brief = 'Stiahni pozície kľúčových slov a ulož surové odpovede API do scratch/seo/.';
    let r = fx.run('delegate.mjs', ['prepare', '--agent', 'reader', '--task', brief]);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.stderr, /reader has no Write, Edit or Bash[^]*Read, Grep, WebFetch[^]*report-dd4ad700/);
    r = fx.run('delegate.mjs', ['prepare', '--agent', 'writer', '--task', brief]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /## Nástroje agenta\n- Typ writer: Read, Write\.\n- Zápis súborov: Write\./);
    r = fx.run('delegate.mjs', ['prepare', '--agent', 'reader', '--task', 'Zisti pozície kľúčových slov a vráť tabuľku.']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /Súbory zapisovať nevie: dáta vráť vo výsledku/);
    fs.writeFileSync(path.join(dir, 'shell.md'), '---\nname: shell\ntools: Read, Bash  # Bash for curl\n---\nbody\n');
    r = fx.run('delegate.mjs', ['prepare', '--agent', 'shell', '--task', brief]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /- Typ shell: Read, Bash\.\n- Zápis súborov: Bash\./);
    r = fx.run('delegate.mjs', ['prepare', '--agent', 'workflow:worker', '--task', brief]);
    assert.equal(r.status, 0, r.out);
    r = fx.run('delegate.mjs', ['prepare', '--agent', 'nobody', '--task', brief]);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.stderr, /agent type nobody not found/);
    r = fx.run('delegate.mjs', ['prepare', '--task', 'Zisti objem hľadanosti z plateného API a z webu.']);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.stderr, /paid source \("plateného"\) without a budget/);
    r = fx.run('delegate.mjs', ['prepare', '--task', 'Zisti objem hľadanosti z plateného API, rozpočet najviac 2 USD.']);
    assert.equal(r.status, 0, r.out);
    const skill = fs.readFileSync(path.join(import.meta.dirname, '..', 'skills/delegate/SKILL.md'), 'utf8');
    assert.match(skill, /--agent <typ>[^]*report-dd4ad700/);
  } finally { fx.cleanup(); }
});
