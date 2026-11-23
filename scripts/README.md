# scripts/

Zdieľaná logika (knižnica) pre `bin/` a `hooks/`: čítanie `.workflow.json` a `local/workflow.json` (P-024), politika (P-017),
git operácie brain (P-040), normalizácia kľúčov (P-031, P-049), napojenie na klienta pošty `agentic-comms` (P-041: cesta z konfigurácie, limit 2 s, cache počtu u klienta),
katalóg dát projektu (`catalog/`: konfigurácia, scan, profily, find, prehľad, PreToolUse; P-031), materiály témy (`materialy.mjs`: limit, záznam, zápisy `save.mjs source|result`; P-062), cieľové repá a cieľová vetva (`target.mjs`), konce riadkov (`eol.mjs`, P-040), slot celého behu testov (`test-slot.mjs`, D-0069: `npm test` čaká na voľný slot, na stroji najviac 2 celé behy testov naraz). Zmrazenie počas prestavby (`freeze.mjs`: stav v politike brainu, odmietnutie kódovej témy; P-074).
Žiadna logika nesmie závisieť od harnessu (P-017) ani od konkrétnej inštancie (P-004).

## Stav témy (spec 10.2, 10.6)

Exporty pre hook Stop, zobudenie pokračovaním a prehľad:

| Modul | Export | Čo robí |
|---|---|---|
| `topic-state.mjs` | `computeState({ next, questions, tasks, alarms })` | stav jednej témy z faktov (10.2 body 1–3): `čakám` pri kroku alebo budíku, inak `otázka` pri položke v Otvorených otázkach alebo Úlohách, inak `hotovo`; argumenty sú zoznamy alebo počty |
| | `summaryState(topics)` | súhrn nad držanými témami (stavy alebo fakty): `čakám` > `otázka` > `hotovo` |
| | `turnAlarms({ next, timers, background, awaiting, turnEnd })` | bežiace budíky s časom: časovač `at`, úloha na pozadí `at` (limit), pošta `wait_due_at` z `obligations.awaiting` (iné údaje pošty nevstupujú), pokračovanie = koniec ťahu iba pri kroku a bez časovača a úlohy na pozadí |
| | `earliestAlarm(alarms)`, `turnFields(facts)` | najskorší budík; polia `turn.state` a `turn.alarm_at` na zápis |
| | `DONE`, `QUESTION`, `WAITING`, `TURN_STATES`, `ALARM_KINDS` | konštanty stavov a druhov budíka |
| `topic-turn.mjs` | `threadAlarms(state, mail)`, `topicFacts(topic, alarms, { turnEnd })`, `factsFields(facts)` | budíky vlákna (časovače, úlohy na pozadí a plánovače, `awaiting` pošty) a fakty držanej témy z handoveru (Ďalší krok, počty Otvorených otázok a Úloh; `null` = sekcia chýba) pre hook Stop |
| | `turnUpdate(ctx, topic, facts, state)`, `stuckNow(ctx, topic, state)` | polia `turn` na zápis na konci ťahu (iba zmenené; po postupe vynuluje `continues` a `stuck`); téma zaseknutá bez postupu nemá pokračovanie |
| | `countContinue(ctx, topics, state, { max })`, `progressed`, `branchHeads`, `markProgress`, `continueMax(policy)`, `STUCK_LINE`, `CONTINUE_RESUME_MS` | počítadlo zobudení pokračovaním: od nuly po postupe (commit `topic/<t>` a `topic/<t>--*`, `progress_at` vlákna: save okrem handoveru, prevzatie správy, správa operátora); zobudenie na strope `topics.continue_max` označí kroky `stuck`; pokračovanie ide pošte s `resume_at` |
| | `verifyLocks(ctx, ids)`, `LOCK_LOST_LINE` | zámok po pull (4.2.4, `syncAndCheckHolder` z `brain.mjs`): témy, ktoré vlákno ešte drží, a stratené |
| `brain-checks.mjs` | `handoverNextStep(text)`, `handoverQuestions(text)`, `handoverTasks(text)` | položky sekcií Ďalší krok, Otvorené otázky, Úlohy pre operátora (riadok so značkou `-`, `*`, `1.` začína položku, `-`/`žiadny` nie je položka); `null`, keď sekcia chýba (taký handover je neplatný, nečíta sa ako prázdny) |
| | `handoverCounts(text)` | `{ next, questions, tasks }` počty položiek pre kontrolu kostry (10.3 bod 1); `null` pri chýbajúcej sekcii |
| | `HANDOVER_SECTIONS`, `NEXT_SECTION`, `QUESTIONS_SECTION`, `TASKS_SECTION` | šesť sekcií handoveru (P-011) |
| `topic-files.mjs` | `fieldsOp(brainDir, id, { turn, mode, repos })` | zápis polí v2 do záznamu témy, zlúčený pri zápise so súborom na disku (`mergeTopicOps`), takže ide jednou operáciou s `holderOp` toho istého zápisu; `turn` sa zlučuje po kľúčoch (`null` ostáva: `alarm_at: null` = bez budíka), `null` pole na vrchnej úrovni maže; neznáme pole odmietne |
| | `V2_FIELDS`, `TURN_FIELDS`, `MODES`, `withFields` | polia `turn` (`state`, `alarm_at`, `stuck`, `continues`), `mode` (`discussion` \| `off`), `repos` (`{ main, list }`); dnešné `state` (working/paused/closed) ostáva |
| `topic.mjs` | `isDiscussionMode(topic)` | režim `discussion` podľa poľa `mode`, nikdy podľa `class` ani `kind` |
| | `setTopicMode(ctx, id, mode)`, `DISCUSSION_NEXT_REFUSAL` | `topic.mjs mode`; odmietnutie kroku v režime diskusie (`save handover`, `topic handoff`) |

Politika: `topics.continue_max` (predvolene 3) je strop zobudení pokračovaním bez postupu (10.2; číta ho `topic-turn.mjs`).

## Zámok, vlastný klon, worktree taskov (spec 3.7, 4.1, 4.2)

| Modul | Export | Čo robí |
|---|---|---|
| `brain.mjs` | `verifyHeldLocks(brainDir, thread)`, `lockLostText(lost)` | pull a overenie zámkov tém, ktoré vlákno drží (4.2.4); `save` pri strate zámku nič nezapíše; `syncAndCheckHolder(brainDir, rel, thread)` ostáva |
| | `withLock(lockPath, fn, busy)` | zámok priečinkom (ako `withBrainLock`) pre iné miesto, napr. vlastný klon |
| `own-clone.mjs` | `cloneWrite(repoDir, { branch, ops, message, index, indexFiles })`, `ownCloneDir(repoDir)` | zápis do repa projektu a repa operátora vo vlastnom klone `<rodič>/.worktrees/<repo>/.clone`: pull, zápis, commit, push, pri odmietnutom pushi znova; INDEX pri konflikte nanovo, iný konflikt = otázka operátorovi; potom fast-forward čistého checkoutu |
| | `cloneMerge(repoDir, { branch, from, message, index, indexFiles })`, `cloneWrite(..., { base })` | `done` zlúči `from` (vetva na origin) do `branch` vo vlastnom klone a pushne (konflikt iba v INDEX.md = nanovo, iný = nič nezlúčené, chyba so súbormi); `base`: nová vetva (`topic/<t>--obsah`) začne z `origin/<base>` |
| `target.mjs` | `targetBranch`, `targetProtected`, `contentTarget(repoDir, id)`, `targetRepos(ctx, topic)`, `defaultRepo(ctx)`, `defaultRepoName(policy)`, `contentWrite`, `mergeRequest` | cieľová vetva repa (`target_branch` v `.workflow.json`, predvolene `main`), `target_protected` → nekódový obsah do `topic/<t>--obsah`; cieľové repá témy (`repos` v `.tema.json`, inak `default_repo` politiky brainu domény); žiadosť o zlúčenie cez `gh` alebo presný príkaz |
| `push-hook.mjs` | `installPushHook(dir)`, `pushFailureLines(dirs)`, `pushBranch(dir, branch)` | post-commit hook worktree témy a tasku (`core.hooksPath` iba toho worktree, ostatné hooky repa cez obal): push každého commitu `topic/*`; zlyhaný push ohlási PostToolUse jedným riadkom |
| `topic.mjs` | `taskCopy`, `taskMerge`, `taskCopyPaths`, `RESERVED_TASKS` | worktree `topic/<t>--<task>` z vetvy témy, zlúčenie po kontrole a zrušenie (meno `obsah` vyhradené) |
| | `takeoverLines(ctx, id)`, `pushedTopicBranches(ctx, topic)` | výpis prevzatia: Hotové a pushnuté vetvy `topic/<t>` a `topic/<t>--*` (4.2.3) |
| | `topicRepoDir(ctx, id)` | repo kópie kódu podľa záznamu témy (`repo`): persona nájde kópiu témy zo svojho brainu |

## Prehľad supervisora (spec 3.9, 4.2.2)

| Modul | Export | Čo robí |
|---|---|---|
| `overview.mjs` | `overview({ root, ctx, brains, now, owed })` | otvorené témy všetkých brainov všetkých domén pod koreňom projektov (`stores.mjs domainBrains`): nálezy `stuck` (`turn.stuck`), `lock` (nečinný zámok), `done` (`hotovo` mimo `mode: discussion`, bez dlžnej odpovede supervisora v `owed`) |
| | `lockIdleSince(facts)`, `lockInactivity(facts, hours)` | nečinnosť zámku (4.2.2): od posledného pushu stavu témy, nie pri `otázka`, `hotovo` a `čakám` pred budíkom, po zmeškanom budíku od jeho času |
| | `overviewLines`, `findingLine`, `findingKey`, `obligationLines`, `isSupervisorSession` | riadky prehľadu a záväzkov pošty pri štarte supervisora; kľúč nálezu pre úlohu `overview` (pošle iba nový nález) |
| | `machineWork({ root, ctx, since, limit })`, `workLines`, `sinceTime` | zoznam práce stroja pre `overview.mjs work`: priečinok so značkou domény alebo s vlastným git repom (repá workflow nemajú brain); brain dáva témy a rozhodnutia, nikdy commity (kópia cudzieho brainu nedá nič). |
| `pre-release.mjs` | `preRelease({ root, ctx, brains, mail })`, `preReleaseLines(res)` | kontrola pripravenosti pred vydaním 2.0 (spec 11.4, plán B19, O22) nad všetkými brainmi stroja, iba čítanie (`ls-remote`, bez fetch): živá téma bez kroku a otázky, vetva `topic/<t>` či `topic/<t>--*` bez commitov na origin, necommitnutý worktree, otvorená správa P-075 (téma s `fix_gate`/`orchestrator`) či P-055 (`handoffs.json`) z `comms obligations` každej témy, nedostupná pošta, brain v dátach 1; poznámky (handover bez šiestej sekcie, `topics.auto.projects`) a domény mimo dát 2.1 s príkazmi `migrate --to 2.1`; postup v `docs/release-2.0.md` |
| `overlap.mjs` | `checkOverlap(ctx, { scope, repo, project, exclude })` | prekryv novej témy s otvorenými témami pri `topic create`: iba riadky `overlap:`, nič neodmieta |

Politika: `overview.interval_min` (predvolene 30) je interval úlohy `overview`; prah nečinnosti zámku `topics.stale_machine_hours` (12).

## Migrácia dát 2.0 → 2.1 (spec 11)

| Modul | Export | Čo robí |
|---|---|---|
| `migrate-3.mjs` | `domainOf(dir)`, `planDomain(dir, { confirmed, approve })`, `applyDomain(dir, { confirmedFile, approveFile })` | doména naraz (brain a repá domény, ktoré ho menujú): plán, potom jeden commit v každom repe, zlyhanie vráti všetky (bez push); `bin/migrate.mjs --to 2.1` |
| | `checkDomain(dir)`, `checkRepo(dir)`, `fixIndexes(dir)` | kontrola dát 2.1 po presune (záznam `migrate-2-3.tsv`, jeden commit, nič z dát 2.0, `zavery/`, handover, polia záznamu, politika, osoby, pravidlá P-050/P-055/P-064/P-075, `INDEX.md`, staré cesty) |
| | `revertList(dir)` | commit presunu a commity po ňom v každom repe (11.7) |
| | `withTasksSection`, `topicRecord3`, `policy3`, `workflowConfig3`, `withTopic` | prevody jedného súboru (šiesta sekcia, záznam témy 2.0, politika bez kľúčov 1.8.0, `target_branch`, `topic:` výstupu) |
