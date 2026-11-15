// ttl: 2026-12-14
// P-068: the fixed work files path check reports a use of scratch/ or temy/<concrete topic>/tmp, not a script comment,
// a shell variable, a case label, a message, a path of another project or a line describing data layout 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixedWorkPaths, WORK_PATH_OK } from '../scripts/skill-check.mjs';

const script = (l) => fixedWorkPaths(l, { script: true });

test('fixedWorkPaths: descriptions, variables and foreign projects pass', () => {
  // Scripts of a persona brain (2026-11-14 false alarms).
  for (const l of [
    'work=$(mktemp -d "$scratch/spec-check.XXXXXX") || exit 2',
    '# The work files from the workflow, not a fixed scratch/ path (operator 2026-11-14).',
    '// it: a brain in layout 2 temy/<held topic or main>/tmp, layout 1 scratch/. --main: the folder of topic main, for a file',
    '#                                                   wrote in the pilot project: under scratch/, or elsewhere when git',
    '# A file outside git to try the pomocne target on (scratch/ of layout 1 is ignored, so the clone has none).',
    'mkdir -p "$p/scratch" && echo log > "$p/scratch/pomocny.log"',
    '        scratch/?*) rm -f -- "$P/$2" && echo "removed $2" ;;',
    '          # Outside scratch/ only a file git sees untracked and not ignored: a tracked or ignored file (local/) is not',
    '            || { echo "--rm outside scratch/ only for an untracked, not ignored file of the pilot project: $2"; exit 2; }',
  ]) assert.deepEqual(script(l), [], l);
  // Skill bodies.
  for (const l of [
    'Pracovné súbory zapisuj do miesta pracovných súborov (tvar 1: <projekt>/scratch/, tvar 2: temy/<téma>/tmp/ repa projektu; mimo gitu, P-052).',
    '3. Pilot, scratch/, .worktrees, archive a nasadené kópie v .claude/skills skript vynecháva.',
    '9. Upratanie: súbory, ktoré test zapísal do pilota, zmaže `--rm` (v scratch/, inde iba nesledovaný a neignorovaný súbor).',
    `Kópia projektu tvaru 1 má scratch/pomocny.log (${WORK_PATH_OK}).`,
  ]) assert.deepEqual(fixedWorkPaths(l), [], l);
});

test('fixedWorkPaths: a real fixed path still fails', () => {
  assert.deepEqual(script('out="$HOME/x/agent/scratch/pub-$kind"'), ['scratch/']);
  assert.deepEqual(script('echo x > scratch/out.md'), ['scratch/']);
  assert.deepEqual(script('cd scratch/repo && git pull'), ['scratch/']);
  assert.deepEqual(script('cp a.txt temy/dev/tmp/a.txt'), ['temy/dev/tmp']);
  assert.deepEqual(fixedWorkPaths('Výsledok zapíš do scratch/<úloha>.txt.'), ['scratch/']);
  assert.deepEqual(fixedWorkPaths('výsledok je v scratch/ a v temy/dev/tmp'), ['scratch/', 'temy/dev/tmp']);
  // A body line is not a script: a leading # or a case-like word does not hide the path there.
  assert.deepEqual(fixedWorkPaths('# Klon do scratch/repo'), ['scratch/']);
});
