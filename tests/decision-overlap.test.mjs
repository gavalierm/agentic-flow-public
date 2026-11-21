// keep: guarded
// A new decision against the valid ones (scripts/decision-overlap.mjs; operator 2026-11-21: a decision of the operator
// cancelled a list an agent's decision had set, both stayed valid). The guards: save decision names the older decision
// the judge says it contradicts (without a judge the candidates by words), --supersede --by marks it, and a decision of
// the agent never replaces a decision of the operator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { parseFrontmatter } from '../scripts/frontmatter.mjs';
import { overlappingDecisions } from '../scripts/decision-overlap.mjs';

const data = (fx, id) => parseFrontmatter(fx.read(fx.git(fx.brain, 'ls-files', `decisions/${id.toLowerCase()}-*`).trim())).data;

test('decision: the save names the valid decisions on its subject; --supersede --by marks the replaced one', () => {
  const fx = setup();
  try {
    // The judge of the test: every candidate it gets is a conflict (WORKFLOW_OVERLAP_JUDGE_CMD, scripts/overlap.mjs askJudge).
    const JUDGE = { WORKFLOW_OVERLAP_JUDGE: 'on', WORKFLOW_OVERLAP_JUDGE_CMD: `node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.stringify({overlaps:[...s.matchAll(/^## id: (\\S+)/gm)].map((m)=>({id:m[1],how:'conflict: zoznam sa ruší'}))})))"` };
    const save = (title, what, extra = [], env = JUDGE) => fx.run('save.mjs', ['decision', title, '--what', what, '--reason', 'operátor to tak chce', '--relates-to', 'src/app.js', ...extra], { env });
    let r = save('Technický motív popisu: zoznam technických druhov tovaru', 'Agent zaradí produkt podľa zoznamu technických druhov tovaru v manuáli: optika, termovízia, fotopasce, svietidlá.', ['--origin', 'agent']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.stdout, /valid decisions/, 'the first decision has no older one');
    r = save('Farba tlačidla košíka', 'Tlačidlo košíka je zelené, nie oranžové.');
    assert.doesNotMatch(r.stdout, /valid decisions/, 'a decision on another subject is no candidate: the judge is not asked');
    // The operator cancels the list: the save names the agent's decision and the command that marks it.
    r = save('Motív popisu podľa oblasti produktu, bez zoznamu druhov tovaru', 'Skill pozná oblasti (technika, oblečenie) a agent produkt zaradí úsudkom. Zoznam technických druhov tovaru v manuáli sa ruší.');
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /decision D-0003 against the valid decisions \(1\): D-0001 "Technický motív popisu[^"]*" \(agent\): conflict: zoznam sa ruší;.*--supersede <D-NNNN>\[,<D-NNNN>\] --by D-0003/);
    assert.equal(data(fx, 'D-0001').status, 'valid', 'the save itself replaces nothing');
    r = fx.run('save.mjs', ['decision', '--supersede', 'D-0001', '--by', 'D-0003']);
    assert.equal(r.status, 0, r.out);
    assert.equal(data(fx, 'D-0001').status, 'superseded-by D-0003');
    assert.equal(data(fx, 'D-0003').supersedes, 'D-0001');
    assert.equal(fx.run('save.mjs', ['decision', '--supersede', 'D-0001', '--by', 'D-0003']).status, 1, 'a replaced decision is not replaced again');
    // A decision of the agent does not replace a decision of the operator, at the save nor after it.
    r = save('Motív popisu určí skript', 'Motív popisu určí skript podľa kategórie produktu; oblasti (technika, oblečenie) ani úsudok agenta sa nepoužijú, zoznam druhov tovaru v manuáli ostáva zrušený.', ['--origin', 'agent', '--supersedes', 'D-0003']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stderr, /D-0003 is a decision of the operator: a decision of the agent .* does not replace it/);
    assert.equal(data(fx, 'D-0003').status, 'valid');
    // Without a judge the save names the candidates by words and says that nothing compared them.
    r = save('Motív popisu určí skript', 'Motív popisu určí skript podľa kategórie produktu; oblasti (technika, oblečenie) ani úsudok agenta sa nepoužijú, zoznam druhov tovaru v manuáli ostáva zrušený.', ['--origin', 'agent'], {});
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /decision D-0004: not compared with the older decisions \(judge off[^)]*\); valid decisions with the most words in common: D-0003 /);
    r = fx.run('save.mjs', ['decision', '--supersede', 'D-0003', '--by', 'D-0004']);
    assert.equal(r.status, 1, r.out);
    assert.equal(data(fx, 'D-0003').status, 'valid');
    // A replaced decision is no candidate any more.
    const old = { id: 'D-0001', title: 'a b', body: 'zoznam technických druhov tovaru manuáli optika' };
    const fresh = { id: 'D-0009', text: 'zoznam technických druhov tovaru manuáli optika' };
    assert.equal(overlappingDecisions([old], fresh).length, 1);
    assert.deepEqual(overlappingDecisions([{ ...old, status: 'superseded-by D-0003' }], fresh), []);
  } finally { fx.cleanup(); }
});
