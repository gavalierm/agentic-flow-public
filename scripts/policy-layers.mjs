// Policy layers (D-0016, D-0025): plugin policy, then the domain brain's policy.json (deepMerge), then the project layer
// (the project's own brain when it is not the domain brain, and <repo>/agentic/policy.json). The project layer may only
// tighten: what it cannot change is ignored and reported, never applied.

/**
 * Class of every policy key a project layer may change (the one table of D-0025). A key not listed (models, commands,
 * topic classes, prompts, thresholds of signals, ...) is ignored. `limits.*` covers every limit the table does not name.
 * - union: deny and ask lists; the layer adds entries, an existing entry is never removed or changed;
 * - intersect: allow and exception lists; the layer keeps or drops entries, it cannot add one;
 * - min: numeric limits and thresholds where a smaller value is stricter; the layer may only lower them;
 * - off: switches that loosen when true; the layer may only turn them off;
 * - ignore: listed to say the direction is unclear, so the layer cannot change it.
 */
export const POLICY_KEY_CLASSES = {
  'harness.deny_paths': 'union',
  'harness.denied_tools': 'union',
  'harness.deny_write_paths_subagent': 'union',
  'harness.subagent_denied_scripts': 'union',
  'harness.ask_commands': 'union',
  'harness.deny_commands': 'union',
  'harness.subagent_deny_commands': 'union',
  'harness.worker_full_test_commands': 'union',
  immutable_principles: 'union',
  'harness.ask_commands_except': 'intersect',
  'harness.subagent_stop_exempt_agent_types': 'intersect',
  'logs.readonly_commands': 'intersect',
  'domain.allow_outside': 'intersect',
  'limits.*': 'min',
  'limits.worker_skill_min_matches': 'ignore',
  'destructive.removed_lines_threshold': 'min',
  'destructive.removed_fraction_threshold': 'min',
  'destructive.files_threshold': 'min',
  'harness.native_memory': 'off',
};

/** Class of a dotted policy key, or null (the layer cannot change it). */
export function keyClass(key) {
  const exact = POLICY_KEY_CLASSES[key];
  if (exact) return exact === 'ignore' ? null : exact;
  const parent = key.includes('.') ? `${key.slice(0, key.lastIndexOf('.'))}.*` : null;
  return (parent && POLICY_KEY_CLASSES[parent]) || null;
}

// A class key lies below this object path, so the walk goes into it instead of ignoring it whole.
const hasClassBelow = (key) => Object.keys(POLICY_KEY_CLASSES).some((k) => k.startsWith(`${key}.`) && POLICY_KEY_CLASSES[k] !== 'ignore');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Identity of a list entry: deny_commands and subagent_deny_commands entries by their `match`, other entries by value.
const entryId = (key, e) => (/^harness\.(?:subagent_)?deny_commands$/.test(key) && isObj(e) ? `match:${e.match}` : JSON.stringify(e));

function tightenValue(key, cls, base, value) {
  if (cls === 'union' || cls === 'intersect') {
    if (!Array.isArray(value)) return { value: base, why: 'not a list' };
    const list = Array.isArray(base) ? base : [];
    if (cls === 'union') {
      const out = [...list];
      const ids = new Map(list.map((e) => [entryId(key, e), e]));
      let changed = false;
      for (const e of value) {
        const id = entryId(key, e);
        if (!ids.has(id)) { out.push(e); ids.set(id, e); } else if (!same(ids.get(id), e)) changed = true;
      }
      return { value: Array.isArray(base) || out.length ? out : base, why: changed ? 'changes an existing entry' : null };
    }
    const want = new Set(value.map((e) => entryId(key, e)));
    const added = value.filter((e) => !list.some((b) => entryId(key, b) === entryId(key, e)));
    const kept = Array.isArray(base) ? list.filter((e) => want.has(entryId(key, e))) : base;
    return { value: kept, why: added.length ? `adds ${added.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join(' ')}` : null };
  }
  if (cls === 'min') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { value: base, why: 'not a number' };
    if (typeof base !== 'number') return { value: base, why: 'no value to lower' };
    return value <= base ? { value } : { value: base, why: `raises ${base} to ${value}` };
  }
  if (cls === 'off') {
    if (typeof value !== 'boolean') return { value: base, why: 'not true or false' };
    return value === false ? { value: false } : base === true ? { value: true } : { value: base, why: 'turns it on' };
  }
  return { value: base, why: 'not a tightening key' };
}

/**
 * Apply a project layer over the composed policy, only in the stricter direction (D-0025). Returns { policy, ignored }:
 * the new policy (base is not changed) and [{ key, why }] for every key the layer could not change. A value equal to the
 * base is never reported.
 */
export function tightenPolicy(base, layer) {
  const ignored = [];
  const policy = structuredClone(isObj(base) ? base : {});
  // Keys the layer cannot change are reported by their leaf (subagents.default_model, not subagents).
  const reportLeaves = (current, v, key) => {
    if (!isObj(v) || !Object.keys(v).length) { ignored.push({ key, why: 'not a tightening key' }); return; }
    for (const [k, x] of Object.entries(v)) if (!same(isObj(current) ? current[k] : undefined, x)) reportLeaves(isObj(current) ? current[k] : undefined, x, `${key}.${k}`);
  };
  const walk =(target, src, prefix) => {
    for (const [k, v] of Object.entries(src)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const current = target[k];
      if (same(current, v)) continue;
      const cls = keyClass(key);
      if (!cls && isObj(v) && hasClassBelow(key)) {
        if (current !== undefined && !isObj(current)) { ignored.push({ key, why: 'not an object' }); continue; }
        const next = isObj(current) ? current : {};
        walk(next, v, key);
        if (Object.keys(next).length && current === undefined) target[k] = next;
        continue;
      }
      if (!cls) { reportLeaves(current, v, key); continue; }
      const res = tightenValue(key, cls, current, v);
      if (res.why) ignored.push({ key, why: res.why });
      if (res.value === undefined) delete target[k]; else target[k] = res.value;
    }
  };
  if (isObj(layer)) walk(policy, layer, '');
  else if (layer !== undefined && layer !== null) ignored.push({ key: '(file)', why: 'not a JSON object' });
  return { policy, ignored };
}

/** The one start line (and adapter note) about the project layer, or null when it has nothing to report. */
export function policyIgnoredLine(ignored) {
  if (!ignored?.length) return null;
  return `policy: project layer ignored (only tightening): ${ignored.map((i) => `${i.key} (${i.why}${i.source ? `, ${i.source}` : ''})`).join(', ')}`;
}

/**
 * Policy sections that set what an agent may do: the write boundary and its exceptions, the deny, ask and tool lists of
 * the harness, the principles no exception overrides, the limits of a destructive change and the release whose hooks
 * enforce all of it. An agent changes none of them by its own decision, in either direction (operator 2026-11-22: an
 * agent with the home folder in domain.allow_outside could rewrite its own policy, and one removed the entry itself and
 * cut its own access). The brain writer asks for the operator's yes (rightsRefusal); the project layer is not concerned,
 * it only tightens (POLICY_KEY_CLASSES).
 */
export const RIGHTS_SECTIONS = Object.freeze(['domain', 'harness', 'immutable_principles', 'destructive', 'workflow_version']);

const shown = (e) => (typeof e === 'string' ? e : JSON.stringify(e));

/** Changed keys of the rights sections between two policies: [{ key, added, removed }] (entries of lists, else the two values). */
export function rightsChanges(before, after) {
  const out = [];
  const walk = (a, b, key) => {
    if (same(a, b)) return;
    if (isObj(a) || isObj(b)) {
      if ((a === undefined || isObj(a)) && (b === undefined || isObj(b))) {
        for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) walk(a?.[k], b?.[k], `${key}.${k}`);
        return;
      }
    }
    const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
    const ids = (v) => new Set(list(v).map((e) => JSON.stringify(e)));
    const [had, has] = [ids(a), ids(b)];
    out.push({ key, added: list(b).filter((e) => !had.has(JSON.stringify(e))).map(shown), removed: list(a).filter((e) => !has.has(JSON.stringify(e))).map(shown) });
  };
  for (const k of RIGHTS_SECTIONS) walk(isObj(before) ? before[k] : undefined, isObj(after) ? after[k] : undefined, k);
  return out;
}

/** One line of the changes, the text the dialog shows the operator. */
export function rightsChangeText(changes) {
  return changes.map((c) => `${c.key}${c.added.length ? ` pridať ${c.added.map((e) => `„${e}“`).join(', ')}` : ''}${c.removed.length ? ` odobrať ${c.removed.map((e) => `„${e}“`).join(', ')}` : ''}`).join('; ');
}

/**
 * A change of the agent's rights passes only after the operator's yes in a dialog of this turn that names every changed
 * key and every entry it adds or removes (`lifts`: the answered dialogs, bypass.mjs turnLifts; a refusing answer is never
 * kept there). Returns the refusal, or null. The operator's own way is the same command in a terminal (the brain writer).
 */
export function rightsRefusal(changes, lifts = []) {
  if (!changes.length) return null;
  const named = (text, c) => text.includes(c.key) && [...c.added, ...c.removed].every((e) => text.includes(e));
  if (lifts.some((l) => changes.every((c) => named(String(l?.text || ''), c)))) return null;
  return `policy ${changes.map((c) => c.key).join(', ')} sets what the agent may do: an agent does not change its own rights, in either direction (P-052, operator 2026-11-22). Nothing written. Only the operator decides: ask in one AskUserQuestion that names each key and each entry, e.g. "Zmeniť práva agenta v policy: ${rightsChangeText(changes)}?", options "Zmeniť" and "Nie, nemeniť", and run the step again in the same turn after a yes; without the operator in this turn (a turn started by a message) give it as an item under **Úlohy pre operátora:**. The operator's own way is the same command in a terminal`;
}
