// ttl: 2026-12-19
// operator 2026-11-19: thread titles were topic slugs and a rename after a topic change came silently in a later turn, so
// the operator looked for the thread under its old title. The title is now a name (topic title or subject), and a rename
// passes only after the operator's yes in a dialog naming the new title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topicTitle, threadTitleSignal, renameGate } from '../scripts/thread-title.mjs';

test('topic title: own title, else the subject cut to a name, else the id', () => {
  assert.equal(topicTitle({ id: 'x', title: 'URL dodávateľa z poznámky', subject: 'whatever' }), 'URL dodávateľa z poznámky');
  assert.equal(topicTitle({ id: 'p', subject: 'Parametrizácia produktov e-shopu: prieskum, návrh registra' }), 'Parametrizácia produktov e-shopu');
  assert.equal(topicTitle({ id: 'a', subject: 'SEO audit kategórie Optika (puškohľady, ďalekohľady) – konkurencia' }), 'SEO audit kategórie Optika');
  assert.ok(topicTitle({ id: 'r', subject: 'Regex úprava čítania URL dodávateľa z internej poznámky obchodu v aplikácii obchodu' }).length <= 40);
  assert.equal(topicTitle({ id: 'only-id' }), 'only-id');
});

test('topic change: the hook asks for a dialog, the rename passes only after the yes naming the title', () => {
  const ctx = { thread: 't1', policy: { thread_title: { command: 't3 thread show --json' } } };
  const sig = threadTitleSignal(ctx, [{ id: 'url-x', title: 'URL z poznámky' }], {}, { read: () => 'Old title', env: { T3CODE_THREAD_ID: 't1' } });
  assert.match(sig.line, /AskUserQuestion/);
  assert.match(sig.line, /„Old title“ na „URL z poznámky“/);
  const call = { action: 'rename', title: 'URL z poznámky' };
  assert.match(renameGate('mcp__t3-code__t3_thread_update', call, []), /never silent/);
  const q = 'Premenovať toto vlákno z „Old title“ na „URL z poznámky“?';
  assert.match(renameGate('mcp__t3-code__t3_thread_update', call, [{ text: `${q}\nNechať „Old title“` }]), /never silent/);
  assert.match(renameGate('mcp__t3-code__t3_thread_update', { ...call, title: 'Iný' }, [{ text: `${q}\nPremenovať na „URL z poznámky“` }]), /never silent/);
  assert.equal(renameGate('mcp__t3-code__t3_thread_update', call, [{ text: `${q}\nPremenovať na „URL z poznámky“` }]), null);
  // a web project, 2026-11-23: a notice of a finished worker started a new turn 2 s after the yes; the kept yes still counts.
  const kept = [{ text: `${q}\nPremenovať na „URL z poznámky“ (odporúčané)` }];
  assert.equal(renameGate('mcp__t3-code__t3_thread_update', call, [], kept), null);
  assert.match(renameGate('mcp__t3-code__t3_thread_update', { ...call, title: 'Iný' }, [], kept), /never silent/);
  assert.match(renameGate('mcp__t3-code__t3_thread_update', { action: 'regenerate_title' }, [], kept), /never silent/);
  assert.match(renameGate('mcp__t3-code__t3_thread_update', { action: 'regenerate_title' }, []), /never silent/);
  assert.equal(renameGate('mcp__t3-code__t3_thread_list', {}, []), null);
});
