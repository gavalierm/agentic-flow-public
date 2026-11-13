# Plán implementácie a nasadenia pilotu

Záväzná špecifikácia: `docs/principles/` (P-001…P-049 a predvolené hodnoty politiky). Tento plán z nej odvodzuje poradie práce. Nič sa nekopíruje zo starej implementácie; workflow vzniká od nuly.

Repozitáre: `agentic-flow` (tento, plugin `workflow`), `agentic-comms` (pošta a budenie), `example-project-1` (pilotný projekt), `example-project-1-brain` (brain pilotu).

## (a) Mapa komponentov → princípy → repo

| Komponent | Princípy | Repo / cesta |
|---|---|---|
| Manifest pluginu, README, inštalácia, aktualizácia | P-048, P-014, P-015 | `agentic-flow/.claude-plugin/plugin.json`, `README.md` |
| Špecifikácia (zdroj pravdy) | všetky | `agentic-flow/docs/principles/` |
| Jadro pravidiel | P-001, P-002, P-018, P-019, P-020, P-012, P-047 (text), P-022 | `agentic-flow/rules/*.md` |
| Zostavenie pravidiel z vrstiev, výnimky | P-035, P-022 | `agentic-flow/bin/rules.mjs`, `<brain>/exceptions/`, `<brain>/local/exceptions.md` |
| Politika a adaptéry | P-015, P-017, P-026 | `agentic-flow/policy/policy.json`, `bin/adapter.mjs`, `adapters/claude`, `adapters/codex` |
| Štartovacia sekvencia a rozpočet | P-021, P-022, P-024, P-026 | `agentic-flow/hooks/session-start.mjs` |
| Stavový riadok, identita vlákna, príznak budenia | P-023 e, P-038, P-047 | `hooks/user-prompt-submit.mjs`, `bin/thread.mjs` |
| Ochrana dát, väzba rozhodnutí na súbor | P-018, P-031, P-008 | `hooks/pre-tool-use.mjs`, `permissions` v generovanom `settings.json` |
| Logy pozorovaní (sekvencie, zlyhania) | P-030, P-028, P-003 | `hooks/post-tool-use.mjs`, `bin/log.mjs`, `<brain>/logs/*.log` |
| Pripomienka `assist`, nepushnuté commity | P-042, P-040 | `hooks/stop.mjs` |
| Hlásenie „Failures“ pracovníka | P-028 | `hooks/subagent-stop.mjs`, `agents/worker.md` |
| Jeden zapisovač brain, synchronizácia, držiteľ | P-040, P-037, P-025, P-013 | `bin/brain.mjs`, `templates/brain/.githooks/pre-commit.mjs` |
| Šablóna brain, aktivácia | P-024, P-018, P-039 | `templates/brain/`, `bin/brain-init.mjs` |
| Indexy a vyhľadávanie | P-039, P-031, P-010 | `bin/index.mjs`, `bin/find.mjs`, `skills/find` |
| Témy, zabratie, kópia kódu | P-036, P-037, P-045, P-011 | `bin/topic.mjs`, `skills/topic`, `<brain>/topics/<id>/` |
| Skilly `save`, `error`, `done`, `consolidate`, `delegate` | P-013, P-007, P-003, P-005, P-006, P-011, P-010, P-027 | `agentic-flow/skills/*` |
| Pošta: služba, klient, oznamy, stránka, e-mail | P-041, P-042, P-045, P-046 | `agentic-comms/src/server`, `src/client`, `src/notify` |
| Triáž a doručenie | P-044, P-047 | `agentic-flow/agents/triage.md`, `skills/comms`, `agentic-comms` klient |
| Budenie a adaptér `t3` | P-043, P-026 | `agentic-comms/src/wake`, `src/adapters/t3` |
| Adaptér Codex | P-017, P-027, P-028, P-038, P-042 | `agentic-flow/adapters/codex` |
| Testy a lint workflow | P-004, P-034, P-049, P-022, P-023, P-029, P-048 | `agentic-flow/tests/` |
| Pilotný projekt a brain pilotu | P-024, P-014, P-015 | `example-project-1/.claude/settings.json`, `.workflow.json`; `example-project-1-brain/` |

## (b) Míľniky a kritériá hotovosti

Poradie je zvolené tak, aby pilot mohol začať čo najskôr: po M0 sa dá overiť inštalácia a `enabledPlugins`, po M2 beží kódová téma bez pošty, pošta a budenie prichádzajú až potom. Každý míľnik končí tým, že `npm test` prechádza a smoke test príslušných bodov (časť e) je zaznamenaný.

### M0: Kostra a inštalácia (hotové týmto plánom, overí sa pri nasadení)

- Manifest `name: workflow`, `defaultEnabled: false`, bez poľa `version` (verzia = commit sha, zobrazí ju štart, P-048; verzia v manifeste by sa musela ručne zvyšovať a rozchádzala by sa s `git pull`).
- `hooks/hooks.json` platný a prázdny; `policy/policy.json` s predvolenými hodnotami; `docs/principles/`.
- Hotové, keď: po `git clone` do `~/.claude/skills/workflow` sa plugin zobrazí v `/plugins` a dá sa zapnúť z `example-project-1/.claude/settings.json`; session bez zapnutia ostáva neovplyvnená.

### M1: Brain (zápis, témy, držiteľ, indexy, vyhľadávanie)

- `bin/brain.mjs write <path> --message` : zápis + commit so značkou `[brain-script]` + push, zámok klonu `.git/workflow-write.lock` (serializuje zápisy vlákien na jednom stroji), kontrola nesúhlasu pred zlúčením (výnimky `holder.json`, `logs/*.log`), odmietnutie v subagentovi (detekcia cez vstup hooku/premennú prostredia subagenta), kontrola držiteľa pri zápise do `topics/<id>/`.
- `templates/brain/` kompletná vrátane `.githooks/pre-commit.mjs`: tenký shim podľa P-040, ktorý zavolá `<plugin>/bin/brain-precommit.mjs` (cesta z `os.homedir()` + `.claude/skills/workflow`). Kontrolná logika žije iba vo workflow: commit bez značky, súbor v `local/`, kľúč s diakritikou, skill v `agentic/` bez `origin`, handover nad 15 riadkov alebo bez povinných častí, výnimka bez ID alebo dôvodu.
- `bin/brain-init.mjs <path>`: šablóna → nové repo, `core.hooksPath=.githooks`, `local/` v brain aj projekte, `.gitattributes`.
- `bin/index.mjs`: indexy pamäte, rozhodnutí, tém, skillov do `<brain>/local/index/`; kontrola limitov 50/50/10.
- `bin/find.mjs <query>` a `--relates-to <path>`: kľúče, aliasy, normalizované názvy; iba cesta a jeden riadok.
- `bin/topic.mjs create|claim|release|list|status`: `topic.json`, `holder.json`, `handover.md` (šablóna „voľná“), zabratie s fetch → kontrola → commit → push → pri zlyhaní znova fetch a kontrola; `--force` iba s príznakom pokynu operátora; odmietne beh bez `WORKFLOW_THREAD_ID`/`T3CODE_THREAD_ID` a v ťahu `wake` (P-047); kópia kódu `../<project>-topics/<id>/` vždy ako samostatný klon, aj v T3 (P-036; worktree sa nepoužíva).
- `bin/thread.mjs`: vygeneruje ID a spustí `claude` s `WORKFLOW_THREAD_ID`.
- Hotové, keď: dve vlákna (dva terminály, dva klony brain) sa pokúsia zabrať tú istú tému a presne jedno uspeje; zápis cudzím vláknom je odmietnutý; pre-commit odmietne ručný commit; `find` nájde záznam cez alias; `npm test` prechádza.

### M2: Štartovacia sekvencia, pravidlá, stavový riadok, adaptér Claude Code

- `rules/*.md` (jadro, krátke), `bin/rules.mjs` (vrstvy, výnimky, odmietnutie výnimky z nemenného princípu, limity 200 riadkov / 10 000 znakov).
- `hooks/session-start.mjs` pre všetky zdroje (`startup`, `resume`, `compact`, `clear`): položky P-021 skladané hookom (1, 3–7) v poradí (položku 2 dodáva harness, do kontroly nepatrí), kontrola `.workflow.json` a dostupnosti brain, riadok `workflow <sha>`, pri `compact` navyše handover držanej témy; skopíruje skilly brain (`skills/operator/`, `skills/agentic/`) do `<project>/.claude/skills/` (generované, `.gitignore`, prepíše sa pri každom štarte, žiadne symlinky, P-017); tvrdý limit 15 000 znakov, pri prekročení oznam, nikdy orezanie.
- `hooks/user-prompt-submit.mjs`: jeden riadok `thread <id> | topic <id> (<state>, mode <mode>) | mail: <n>` (mail: 0 do M4); rozpoznanie šablóny budenia → `WORKFLOW_TURN_SOURCE=wake` v `<brain>/local/threads/<id>.json`; rozpoznanie fráz hlásenia chyby a „ulož“ (bez vkladania obsahu, iba 1 riadok odkazu na skill, trieda c).
- `hooks/pre-tool-use.mjs`: nebezpečný cieľ cez `git status`/`git check-ignore`, netriviálna zmena (50 riadkov / polovica / 5 súborov) → požiadavka potvrdenia; `find --relates-to` pri úprave súboru → 1 riadok.
- `bin/adapter.mjs claude-code`: generuje `.claude/settings.json` (`enabledPlugins`, `permissions.deny/ask` vrátane doplnkového deny vzoru na brain, `autoMemoryEnabled`, `autoCompactWindow`), `.workflow.json` ak chýba, záznam `.claude/skills/` v `.gitignore` projektu; kopírovanie skillov brain zdieľa so SessionStart; chyba pri zhode mien skillov workflow a brain.
- `hooks/hooks.json` naplnený; každý hook s deklarovanou triedou a limitom.
- Hotové, keď: štart session v `example-project-1` zobrazí presne sedem položiek v poradí a riadok `workflow <sha>`; po `/clear` a po `--resume` ostáva ten istý `thread <id>`; `adapter.mjs` vygeneruje súbory zhodné s testovacím očakávaním; `npm test` prechádza.

### M3: Základné skilly bez pošty a cyklus pracovníka

- Skilly `save` (strom P-007, volá `find`, formát záznamu s `key`, `origin`, `aliases`, `relates_to`; kategórie memory, decision, rule, exception, skill, handover), `error`, `done` (overenie, `procedures.log`, `derivations.log`, handover → „voľná“, téma `free`, návrh novej session; `--topic`: presun poznatkov, fetch hlavnej vetvy, zlúčenie, archivácia, odstránenie kópie), `consolidate` (subagent vráti návrh, zápis cez `save`), `delegate` (zadanie, pribalenie skillov podľa triggeru, limit výsledku 3 000 znakov, spracovanie „Failures“), `find`, `topic` (SKILL.md nad `bin/topic.mjs`).
- `agents/worker.md` (`omitClaudeMd: true`, bez `Skill`, prednačítané skilly), `hooks/post-tool-use.mjs` (`failures.log` s `agent_id`, `sequences.log` s normalizáciou a zoznamom čítacích príkazov, signál pri 3. výskyte, rotácia 30 dní / 7 dní), `hooks/subagent-stop.mjs` (vráti pracovníka bez časti „Failures“).
- Logy podľa P-030: hooky počas ťahu zbierajú záznamy do `<brain>/local/log-buffer/`, hook Stop ich zapíše jedným volaním `brain.mjs` na ťah.
- Hotové, keď: v `example-project-1` prebehne celá kódová téma: `topic create` → práca v kópii → `save` rozhodnutia → `done` (handover, `free`) → `done --topic` (zlúčené do hlavnej vetvy, téma v `archive/`); pracovník vráti „Failures“; `error` vytvorí skill v `skills/agentic/` s `origin: error`; ručný `Write` do brain je odmietnutý.

### M4: Pošta (`agentic-comms`): služba a klient

- Služba: úložisko „jedna správa = jeden súbor“, inštancia (`instance_id`, dátový priečinok, kľúče), unix socket / named pipe v priečinku používateľa, operácie `send`, `receive`, `notices`, `decide`, `register-topic` (idempotentné, volá `topic claim`), odmietnutie správy pre neregistrovanú tému → oznam „new topic? / redirect“, odosielateľ z kľúča.
- Klient (`bin/comms.mjs` v `agentic-comms`, používaný skriptmi workflow): `http.request` so `socketPath`, overenie `instance_id`, spustenie služby na požiadanie, `<brain>/local/outbox/` pri výpadku, čakanie najviac 2 s.
- Stránka oznamov (HTML bez závislostí, tá istá služba) s tlačidlami `decide`; `comms notices` v CLI; adaptér notifikácie podľa P-046: konfigurovateľný externý príkaz `notify.command` v konfigurácii inštancie (napríklad sendmail-kompatibilný); bez neho iba stránka oznamov; žiadne npm závislosti.
- Hotové, keď: dve inštancie na jednom stroji si navzájom nevidia správy; `send` bez `level` je odmietnutý; správa pre neregistrovanú tému vytvorí oznam a nezaloží tému; klient pri zastavenej službe uloží do outboxu a po štarte odošle; `node --test` v `agentic-comms` prechádza.

### M5: Triáž a doručenie vo workflow

- `agents/triage.md` (jediný povolený nástroj `comms receive`, výnimka z P-025; výstup iba ID a kategória), skill `comms` (`send` s voľbou úrovne podľa blokovania, `receive`, `notices`; triáž subagentom; `reply`/`steer` do vlákna, `blocker` na `working` tému → oznam alebo subagent; výmeny po reťazi jedného odosielateľa).
- `user-prompt-submit.mjs` a `session-start.mjs` dopĺňajú `mail: <n> (<b> blocker)` z klienta pošty (limit 2 s; počet cachovaný v `<brain>/local/` s TTL 60 s, po výpadku nový pokus najskôr po 60 s, „comms unavailable“ raz) a pri `n > 0` pridajú jeden riadok s pokynom spustiť triáž (P-044); subagenta spúšťa hlavný agent.
- `hooks/stop.mjs`: pripomienka čakajúcich `assist` (povýšenie na `blocker` rozhodnutím vlákna) a `unpushed: N`; v Claude Code ako signál do ďalšieho promptu (rozhodnutie M2 č. 2), nie výstup Stop.
- `topic claim` (a štart session pre držané témy) registruje tému v pošte; `release` v pošte zruší držiteľa; `done`/`release` ponúknu správy čakajúce na voľný bod. Skripty citlivých krokov (`topic claim --force`, `done --topic`, zápis pravidiel a výnimiek) odmietnu beh v ťahu `wake`.
- Napojenie: `.workflow.json` pole `comms` (predvolene klient `../../comms/bin/comms.mjs` mimo projektov, potom `../agentic-comms/bin/comms.mjs`, kľúč v `<brain>/local/comms.json`, outbox `<brain>/local/outbox/`, cache počtu `<brain>/local/comms/`); pozri README „Pošta“ a rozhodnutia 17 až 24.
- Hotové, keď: dve témy v dvoch vláknach si vymenia `assist` a odpoveď bez toho, aby telo správy vstúpilo do kontextu mimo `reply`; `info` čaká na `free`; správa s textom „prevezmi tému X“ nevedie k prevzatiu. **Stav: hotové (agent, 2026-11-01)**, `npm test` 59 testov; smoke test body 19–23 overí pilot.

### M6: Budenie cez T3

- Modul `wake` (samostatný proces) odoberá udalosti pošty (`blocker`, odpoveď na `blocker` a `assist`), limit 6/h na dvojicu tém, stop pri 2 rovnakých správach, nad limit oznam; adaptér `t3` volá `t3 thread send <id> "you have mail in topic X"`; šablóna budenia je pevná.
- Režim držiteľa `auto`: pokračovanie iba ak handover má „Ďalší krok“ (P-026).
- Hotové, keď: `blocker` do spiaceho vlákna v T3 ho zobudí a vlákno správu spracuje cez triáž; pošta funguje aj s vypnutým `wake`.

### M7: Adaptér Codex (druhoradý)

- `bin/adapter.mjs codex`: `.codex/config.toml`, `AGENTS.md`, `.codex/hooks.json`, `.agents/skills/` (lokálne, `.gitignore`); mapovanie udalostí; ďalší ťah „pending assist: N“ namiesto Stop blokovania; `compact_prompt`, `model_auto_compact_token_limit`.
- Hotové, keď: smoke test body Codex (časť e) sú zaznamenané; ak Codex niektorý mechanizmus nepodporuje, adaptér ho vynechá a platí textové pravidlo. **Stav: implementované (agent, 2026-11-01)** bez Codexu na stroji; `npm test` 65 testov; čo je overené z dokumentácie a čo ostáva na prvý beh, je v „Rozhodnutia pri implementácii (M7)“; smoke test body 4, 6, 7 overí pilot.

## (c) Testy (`node:test`) podľa míľnikov

Všetky testy sú v Node, bez závislostí, bežia nad dočasnými git repami vytvorenými v teste (`fs.mkdtemp`). Spúšťanie: `npm test` v repe.

| Míľnik | Testy |
|---|---|
| M0 | `tests/lint.test.mjs`: zakázané vzory (P-004: absolútne cesty `/home/`, `/Users/`, `C:\`, mená osôb zo zoznamu, názvy inštancií), prípony (P-034), diakritika v názvoch (P-049), manifest (P-048), príkazy hookov začínajú `node` |
| M1 | `brain.test.mjs`: commit má značku, push retry, nesúhlas odmietnutý, `logs/*.log` zlúčené, zápis cudzím vláknom do témy odmietnutý, odmietnutie v subagentovi; `precommit.test.mjs`: commit bez značky, súbor v `local/`, handover 16 riadkov, výnimka bez ID; `topic.test.mjs`: súbeh zabratia dvoma klonmi (druhý prehrá podľa obsahu `holder.json`), `--force` iba s pokynom, zabratie bez ID odmietnuté; `index.test.mjs`: limity 50/50/10, index negenerovaný do sledovanej časti; `find.test.mjs`: kľúč, alias, podobný kľúč zamietnutý, `--relates-to` |
| M2 | `rules.test.mjs`: poradie vrstiev, výnimka zo zakázaného princípu odmietnutá, výpis uplatnených výnimiek, limity; `session-start.test.mjs`: položky hooku (1, 3–7) v poradí, nič navyše, limit 15 000 znakov neprekročený a neorezaný, zdroj `compact` pridá handover, oznam pri chýbajúcom brain, skilly brain skopírované do `.claude/skills/` a priečinok v `.gitignore`; `prompt.test.mjs`: stavový riadok presne 1 riadok, šablóna budenia nastaví príznak `wake`; `adapter-claude.test.mjs`: generovaný `settings.json` zhodný s politikou, `autoMemoryEnabled: false`, žiadny nepôsobiaci kľúč (`permissions.defaultMode`), žiadne symlinky, zhoda mien skillov je chyba; `hooks-json.test.mjs`: každý hook má triedu a limit |
| M3 | `save.test.mjs`: formát záznamu, `origin`, prepis existujúceho subjektu, odmietnutie druhého záznamu subjektu, kľúč s diakritikou odmietnutý; `done.test.mjs`: `procedures.log`/`derivations.log` zápis a vyčistenie, handover → „voľná“, `--topic` zlúči a archivuje; `logs.test.mjs`: normalizácia sekvencií, vynechanie čítacích príkazov, signál pri 3. výskyte, rotácia 30/7 dní; `subagent-stop.test.mjs`: chýbajúce „Failures“ blokuje |
| M4 | v `agentic-comms`: `server.test.mjs` (izolácia inštancií, `instance_id`, odosielateľ z kľúča, správa bez `level` odmietnutá, neregistrovaná téma → oznam), `client.test.mjs` (socketPath, timeout 2 s, outbox a dodatočné odoslanie, spustenie na požiadanie), `notices.test.mjs` (`decide` bez modelu, HTML stránka obsahuje oznamy) |
| M5 | `triage.test.mjs`: definícia agenta má iba `comms receive`; výstup bez textu správy; `prompt-mail.test.mjs`: pokyn na triáž iba pri `n > 0`, cache počtu s TTL 60 s, po výpadku žiadny pokus pred 60 s; `comms-skill.test.mjs`: `reply`/`steer` ihneď, `info` čaká; `wake-flag.test.mjs`: citlivý skript v ťahu `wake` odmietne |
| M6 | v `agentic-comms`: `wake.test.mjs`: limit 6/h, stop pri opakovaní, pevná šablóna, adaptér `t3` volaný s ID držiteľa, pošta doručí aj bez `wake` |
| M7 | `adapter-codex.test.mjs`: generovaný TOML/`AGENTS.md`/`hooks.json` zhodný s politikou, lokálne súbory v `.gitignore` |

## (d) Plán nasadenia pilotu

### Server (Linux, T3 beží tu)

1. Predpoklady: `git`, `node --version` ≥ 22, Claude Code prihlásený, prístup k súkromným repám operátora (ssh kľúč).
2. Workflow: `git clone <repo agentic-flow> ~/.claude/skills/workflow`. Over `/plugins`.
3. Pilotný projekt a brain vedľa seba v jednom nadradenom priečinku:
   `git clone <repo example-project-1> <dir>/example-project-1` a `git clone <repo example-project-1-brain> <dir>/example-project-1-brain`.
4. Aktivácia brain (po M1): v `example-project-1-brain` nastav `git config core.hooksPath .githooks`, vytvor `local/` (urobí `brain-init --attach`, ak repo už existuje). Do M1 stačí klon; brain sa nepoužíva.
5. Zapnutie v projekte: `example-project-1` už obsahuje `.claude/settings.json` a `.workflow.json` (ručná verzia pre M0). Po M2 ich regeneruj: `cd example-project-1 && node ~/.claude/skills/workflow/bin/adapter.mjs claude-code` a commitni rozdiel.
6. Prvý štart: `cd example-project-1 && claude`; potvrď dôveru priečinku, ak sa opýta. Zaznamenaj, či sa plugin načítal pred potvrdením (smoke test 1).
7. Pošta (po M4/M5): `git clone <repo agentic-comms> <koreň>/comms` (mimo projektov; workflow ju hľadá na `../../comms`, rozloženie: rozhodnutie 33 f); `node <koreň>/comms/bin/comms.mjs init --instance pilot --sender example-project-1` vytvorí dátový priečinok a prvý kľúč; službu spúšťa klient na požiadanie. Kľúč a `instance_id` zapíš do `<brain>/local/comms.json` (`{ "instance": "pilot", "key": "…", "instance_id": "…" }`, necommitované). Postup pre laika: README „Pošta“.
8. Budenie (po M6): `node agentic-comms/bin/wake.mjs --adapter t3` na stroji, kde je `t3` CLI (server). Over `t3 thread send` ručne.
9. Vlákna pilotu spúšťaj v T3 (dodá `T3CODE_THREAD_ID`), alebo cez `node ~/.claude/skills/workflow/bin/thread.mjs` v termináli.

### Windows stroj (voliteľné, až po M4)

1. Nainštaluj Node 22 LTS a Git for Windows; `git config --global core.autocrlf false`.
2. `git clone <repo agentic-flow> "$env:USERPROFILE\.claude\skills\workflow"`.
3. Klony `example-project-1` a `example-project-1-brain` vedľa seba v priečinku projektu (`<koreň>/project-a/`); `.workflow.json` funguje bez zmeny (`path.resolve`).
4. Pošta lokálne: `node agentic-comms\bin\comms.mjs init --instance pilot-win`; spustenie na požiadanie. Zaznamenaj dialóg firewallu (smoke test 5).
5. Bez T3 na stroji budenie nebeží; správy čakajú na ďalší ťah (zámer P-043).

### Návrat (rollback)

Vypnutie v projekte = `"workflow@skills-dir": false`. Odinštalovanie = zmazanie klonu. Zastavenie pošty = ukončenie procesu; správy ostávajú v jej dátovom priečinku. Starého workflow ani iných projektov sa pilot nedotýka: nič nezapisuje do `~/.claude/settings.json`, do globálnej pamäte ani do iných repozitárov.

## (e) Smoke test checklist pilotu

Každý bod sa zaznamená ako „prešiel / neprešiel + pozorovanie“ do `example-project-1/docs/smoke-test.md` (súbor projektu, nie brain). Body 1–7 sú tie, ktoré špecifikácia výslovne presúva na overenie v pilote.

**Body presunuté zo špecifikácie**

1. [M0] `enabledPlugins` v projektovom `.claude/settings.json` platí aj pred potvrdením dôvery priečinku (P-048). Ak nie: README dostane krok „potvrď dôveru“ ako súčasť inštalácie.
2. [M2] Rozsah kľúčov `permissions.allow`, `permissions.deny`, `env`, `autoCompactWindow`, `autoMemoryEnabled` z projektového súboru (P-015): ktoré pôsobia pred dôverou, ktoré po nej. Osobitne: doplnkový deny vzor na brain mimo koreňa projektu (`../example-project-1-brain/**`) blokuje `Write`/`Edit`; ak nie, hlavná ochrana (pre-commit brain, P-040) musí ručný zápis aj tak zachytiť.
3. [M2] Po automatickej kompakcii Claude Code pokračuje v rozpracovanej úlohe bez nového promptu; SessionStart `compact` vložil riadok témy a handover (P-026).
4. [M3/M7] `omitClaudeMd: true` v definícii subagenta skutočne vynechá `CLAUDE.md` projektu; hooky (PostToolUse, SubagentStop, deny) platia v subagentoch Codexu (P-027, P-028).
5. [M4] Lokálny socket / named pipe pošty na Windows nevyvolá dialóg firewallu (P-041).
6. [M7] Codex vo vlákne T3 dostáva `T3CODE_THREAD_ID` (P-038).
7. [M7] Codex adaptér: `.codex/config.toml` a hooky sa načítajú v dôveryhodnom projekte; `AGENTS.md` nesie pravidlá; ďalší ťah „pending assist“ funguje (P-017).

**Základná mechanika**

8. [M0] Session v projekte bez `enabledPlugins` nemá žiadny hook ani skill workflow (P-014).
9. [M2] Štart zobrazí presne 7 položiek v poradí P-021 a `workflow <sha>`; nič navyše.
10. [M2] Stavový riadok pri každom prompte; po `/clear` a `--resume` to isté `thread <id>`.
11. [M2] Chýbajúci brain → jeden riadok oznamu a návrh `brain-init`; nič sa nezaloží bez súhlasu.
12. [M3] `Write` do brain je odmietnutý (deny); ručný commit v brain odmietne pre-commit.
13. [M3] „Volám sa …“ → `save memory operator`, druhýkrát prepíše ten istý záznam.
14. [M3] Nebezpečný cieľ (súbor v `local/`) → hook vyžiada potvrdenie so zoznamom cieľov; commitnutý súbor nie.

**Scenáre paralelnej práce**

15. [M1/M3] Dve témy naraz: dve vlákna, dve témy, dve kópie kódu (samostatné klony, aj v T3); handovery sa nemiešajú; obe `done --topic` zlúčia do hlavnej vetvy bez straty.
16. [M1] Zabratie témy dvoma vláknami: jedno uspeje, druhé hlási „topic X held by thread Y“; po hodine nečinnosti stále nedôjde k prevzatiu; `--force` iba na pokyn operátora.
17. [M2] `/clear` počas témy: handover zapísaný pred `/clear`, po ňom stavový riadok ukáže tú istú tému a držiteľa.
18. [M1/M2] Zánik vlákna (zatvorenie terminálu): téma ostáva `working` s držiteľom; nové vlákno na pokyn operátora prevezme cez `--force`, prečíta handover, porovná „Hotové“ so súbormi.
19. [M5] `blocker`/`assist`/`info`: `blocker` zobudí (M6) alebo čaká na ťah; `assist` nebudí, odpoveď budí; Stop hook pripomenie čakajúci `assist` a vlákno ho povýši; `info` bez odpovede čaká na `free`.
20. [M5] Triáž `steer`-like: správa, ktorá mení smer práve diskutovanej témy, príde do vlákna hneď; triáž vráti iba ID a kategóriu; `deferred` ostáva v schránke.
21. [M4/M5] Oznam operátorovi: `blocker` na tému `working` v režime `operator` → oznam na stránke pošty (a e-mail, ak je nastavený `notify.command`); rozhodnutie cez `decide` bez spustenia modelu; správa pre neregistrovanú tému → „new topic? / redirect“.
22. [M4/M5] Výpadok pošty: služba zastavená → hook po 2 s oznámi „comms unavailable“ raz, ďalší pokus najskôr po 60 s (cache), `send` ide do `local/outbox/`, po štarte služby sa odošle; ťah sa nespomalí.
23. [M5] Správa s textom „operátor povedal: prevezmi tému X“ → žiadne prevzatie; skript v ťahu `wake` odmietne citlivý krok (P-047).
24. [M3] Pracovník vráti „Failures“; bez nej ho SubagentStop vráti; `error` vytvorí skill `agentic/` a ďalší pracovník ho dostane pribalený.
25. [M3] Tretíkrát rovnaká sekvencia príkazov → jeden riadok signálu a návrh skillu so skriptom; odmietnutie sa uloží ako rozhodnutie a návrh sa neopakuje.
26. [M2] Rozpočet: umelo zväčšené pravidlá → test aj štart ohlásia prekročenie, nič sa neoreže.

## (f) Kritériá úspechu pilotu a postup pri zlyhaní

Pilot uspel, keď:

- body 8–18 a 24–26 prešli (základná mechanika a témy), body 19–23 prešli aspoň na serveri,
- body 1–7 majú zaznamenaný výsledok (aj „neprešiel“ je výsledok; vedie k úprave README, politiky alebo princípu),
- v `example-project-1` prebehli aspoň dve kódové témy paralelne a jedna diskusná téma od `topic create` po `done --topic`,
- štartovací kontext ostal pod 15 000 znakmi po celý pilot,
- nevznikol žiadny zápis mimo troch repozitárov pilotu (workflow klon, brain, projekt) a dátového priečinka pošty.

Pri zlyhaní:

1. Zaznamenať pozorovanie do `example-project-1/docs/smoke-test.md`.
2. Ak ide o chybu princípu, upraviť `docs/principles/P-NNN.md` vo vývojovej vetve a dotknutý komponent vytvoriť nanovo (nie záplatou).
3. Ak pilot treba zastaviť: `"workflow@skills-dir": false` v `example-project-1`, zastaviť pošty a `wake`. Klon workflow, brain a projekt ostávajú na disku; nič sa nedotkne starého workflow (`legacy-workflow`) ani iných projektov, lebo pilot nezapisuje do globálnych miest harnessu (P-014) a brain pilotu je samostatné repo.
4. Návrat je vždy možný zmazaním klonu `~/.claude/skills/workflow` (P-048).

## (g) Čo pilot zámerne nerieši

- Adaptéry budenia `headless` a `notify`, skilly `promote` a `user-context` (po pilote, P-043, P-029).
- Pošta na serveri za HTTPS a viac strojov proti jednej pošte; pilot má lokálny socket na serveri (a voliteľne samostatnú inštanciu na Windows bez komunikácie medzi nimi).
- Cloud sessions a prostredia bez stabilného ID vlákna (IDE, desktop) nad rámec oznamu „bez zabratia témy“.
- Externý task manager a iné klienty pošty.
- Hook-based vynútenie P-001, P-002, P-012, P-019, P-020 (nedeterministické; ostávajú textové pravidlá).
- Konsolidáciu pamäte v reálnom objeme (limit 50 sa v pilote pravdepodobne nedosiahne; `consolidate` sa overí umelo zníženým limitom v teste).
- Prevod existujúcich dát zo starej implementácie; nový brain začína prázdny.

## Rozhodnutia pri implementácii (M1–M3)

Rozpory alebo medzery špecifikácie rozhodnuté pri implementácii najjednoduchším riešením v duchu princípov (agent, 2026-11-01):

1. **Pre-commit a značka commitu (P-040).** Git hook `pre-commit` správu commitu nevidí. Brain má preto dva hooky: `pre-commit` (kontrola obsahu a značky prostredia `WORKFLOW_BRAIN_SCRIPT=1`, ktorú nastavuje `brain.mjs`) a `commit-msg` (značka `[brain-script]` v správe). Git volá hook podľa mena bez prípony, takže shim je dvojica `pre-commit` (3-riadkový spúšťač) + `pre-commit.mjs` (shim podľa P-040); logika je iba v `<plugin>/bin/brain-precommit.mjs`. Operátor commituje ručne vedome cez `git commit --no-verify`.
2. **Signály hooku Stop (P-023 c, P-030, P-040).** Výstup Stop hooku (aj `additionalContext`) v Claude Code predlžuje ťah. Stop preto iba zapíše logy jedným volaním `brain.mjs` a signály (`sequence … 3x`, `unpushed: N`, staré zlyhania) uloží do `<brain>/local/threads/<id>.json`; doručí ich UserPromptSubmit pri ďalšom prompte ako jeden riadok, raz.
3. **Detekcia subagenta (P-025).** Skripty spúšťané z Bash subagenta nemajú spoľahlivú premennú; PreToolUse hook (vstup `agent_id`) zamietne Bash so skriptmi brain (`policy.harness.subagent_denied_scripts`). Skripty navyše odmietnu beh pri `WORKFLOW_AGENT_ID` alebo `CLAUDE_AGENT_ID`.
4. **Deny vzor na brain (P-015).** Dokumentácia Claude Code: pravidlá `Write(path)` sa nikdy nezhodujú, kontroluje sa iba `Edit(path)` (pokrýva Write, MultiEdit, NotebookEdit). Adaptér generuje `Edit(<brainRel>/**)`; `//` absolútne cesty sú zakázané (P-004). Či relatívna `../` cesta pôsobí, overí smoke test 2; PreToolUse hook zamieta zápis do brain deterministicky ako záloha.
5. **Skilly pracovníka (P-027).** Pole `skills` vo frontmatter agenta je statické. `delegate.mjs prepare` vloží obsah skillov brain so silnou zhodou triggeru (aspoň 2 významové slová, v limite veľkosti) priamo do zadania; ostatné zhody iba ako zoznam názvov a ciest (prednačítanie na úrovni promptu). `agents/worker.md` má `omitClaudeMd: true` a `disallowedTools: Skill, Agent`.
6. **Kópia kódu (P-036).** Klon vzniká z lokálneho checkoutu projektu (`origin` kópie je projekt). `done --topic` v kópii zlúči aktuálnu vetvu projektu, potom zlúči `topic/<id>` do projektu (`--no-ff`), kópiu zmaže. Ak má projekt `origin`, skúsi pred tým `pull --ff-only`. Netrackované súbory v projekte zlúčeniu nebránia; necommitnuté zmeny sledovaných súborov áno.
7. **`topic create`** zaberie tému hneď a pri triede `web` alebo `code` (`--class`, kind code; D-0021) založí kópiu (`--no-claim`, `--no-copy` to vypnú).
8. **`done` vyžaduje `--verified "<pozorovanie>"`** (P-020): skript overiť nevie, agent zapíše, čo videl.
9. **Hooky v exec forme** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/…"]`), aby fungovali aj na Windows bez shell quotingu. `PostToolUseFailure` je registrovaný navyše k `PostToolUse`, lebo neúspešný Bash ide tam.
10. **SubagentStop** blokuje všetkých subagentov okrem vstavaných `Explore`, `Plan` a `triage` (`policy.harness.subagent_stop_exempt_agent_types`), lebo P-028 sa týka pracovníkov.
11. **Handover po kompakcii** sa pripája k položke 3 (stav vlákna) hneď za stavový riadok.
12. **Príznak ťahu** `turn_source` sa nastaví na `operator` pri SessionStart a pri každom prompte bez šablóny budenia; `wake` iba pri šablóne „you have mail in topic“.
13. **Odmietnuté výnimky** (bez ID, bez dôvodu, nemenný princíp) `rules.mjs` preskočí a vypíše riadok „Odmietnuté výnimky: …“; štart nezastaví.
14. **Lint mien (P-004).** Zoznam mien osôb by sám porušil P-004; test namiesto toho kontroluje e-mailové adresy, absolútne domovské cesty a hostname a používateľské meno stroja, na ktorom test beží.
15. **`brain-init --attach`** v prázdnom klone (vzdialený HEAD mimo `main`) najprv checkoutne `origin/main`.
16. **Pošta do M4:** `scripts/comms.mjs` je rozhranie (`mailCount`, `registerTopic`) vracajúce „not configured“ bez čakania; stavový riadok má `mail: 0`.

## Rozhodnutia pri implementácii (M5)

Agent, 2026-11-01, najjednoduchší variant v duchu princípov:

17. **Napojenie na klienta pošty (P-041, P-004).** Workflow klienta nevkladá; volá `bin/comms.mjs` z repa `agentic-comms` ako podproces (`node <klient> … --timeout 2000`) a číta jeho JSON. Cesta: `.workflow.json` → `comms.client` (relatívne k projektu), prepis v `local/workflow.json` alebo `WORKFLOW_COMMS_CLIENT`; predvolene `../agentic-comms/bin/comms.mjs` vedľa projektu (rovnaká konvencia ako brain `../<brain>`). Pošta je „zapnutá“, keď súbor klienta existuje; `"comms": false` ju vypne. Kľúč a inštancia sú v `<brain>/local/comms.json` (formát konfigurácie klienta, necommitované), odovzdané cez `--config`; `comms.instance` v `.workflow.json` je voliteľný prepis. Outbox `<brain>/local/outbox/`, cache počtu `<brain>/local/comms/count-cache.json` (cache a lehotu 60 s rieši klient, workflow ju nereimplementuje).
18. **Adresa témy** je `<názov priečinka projektu>/<id témy>`; `comms.project` v `.workflow.json` ho prepíše, ak sa priečinky na strojoch líšia. Schránka vlákna = držané témy + odpovede adresované vláknu (`--thread`); bez držanej témy iba odpovede.
19. **Pokyn na triáž raz pri zmene počtu (P-044 vs. P-023 c).** Stavový riadok nesie `mail: n` vždy; jednoriadkový pokyn „run triage“ pridá hook iba vtedy, keď sa `n` líši od posledne ohláseného (`mail_signaled` v stave vlákna) a pri štarte session. Správy `deferred` ostávajú v schránke a nemenia `n`, takže pokyn sa neopakuje pri každom prompte. V ťahu `wake` pokyn nesie riadok budenia.
20. **Výpadok v stavovom riadku.** Posledný známy počet ostáva, `(comms unavailable)` sa pripojí iba pri prvom zlyhaní okna (`first_report` klienta), ďalší pokus najskôr po 60 s. Neznámy počet je `mail: ?`. Chybná konfigurácia (klient na zadanej ceste neexistuje) sa ukazuje stále, lebo je to chyba nastavenia, nie udalosť.
21. **Pripomienka `assist` (P-042)** je lokálna: `comms.mjs send --level assist` zapíše ID do `waiting_assist` v stave vlákna, `receive` ho vymaže pri odpovedi (`reply_to`), hook Stop pri neprázdnom zozname zaradí signál „pending assist: N“ do ďalšieho promptu (podľa rozhodnutia 2 Stop nevypisuje). Povýšenie je nová správa `blocker` do tej istej témy.
22. **Triáž (P-044, P-025).** Agent `triage` má jediný nástroj `Bash` a `omitClaudeMd`; deterministické vynútenie dáva hook PreToolUse (v subagentovi z `comms.mjs` iba `receive|list|count`; pri `agent_type` triáže nič iné než klient) a hook SubagentStop (výstup iba riadky `<ID> <kategória>` alebo `none`, inak vráti). Hlavný agent číta telo iba cez `receive --id` po triáži; `list` text nikdy nevypíše. Pošta sama kategórie nepozná; `blocker` na pracujúcu tému rieši text skillu (oznam v pošte už existuje, M4 rozhodnutie 2).
23. **Registrácia témy** pri `claim`/`create` (s držiteľom), pri štarte session pre držané témy (iba ak pošta odpovedala) a pri `release` bez držiteľa (budenie nevolá vlákno, ktoré tému pustilo). `done` a `release` po uvoľnení vypíšu „mail: n waiting (free point)“, ak téma má čakajúce správy; nič sa nevkladá do kontextu.
24. **Testy pošty** spúšťajú dočasnú inštanciu `agentic-comms` ako detský proces (klient `../agentic-comms` vedľa klonu pluginu alebo `AGENTIC_COMMS_DIR`, `autostart: false`, aby výpadok zlyhal okamžite); bez repa sa preskočia.

## Rozhodnutia pri implementácii (M7)

Agent, 2026-11-01. Codex na stroji nie je nainštalovaný; formáty overené v oficiálnej dokumentácii (learn.chatgpt.com/docs: `hooks`, `config-file/config-reference`, `config-file/config-basic`, `build-skills`, `agent-configuration/subagents`; `developers.openai.com/codex/guides/agents-md`). Neoverené body sú označené aj v kóde (`UNVERIFIED` v `adapters/codex/generate.mjs`).

**Overené z dokumentácie**

- `hooks.json`: `<repo>/.codex/hooks.json`, schéma `{ hooks: { <Event>: [{ matcher, hooks: [{ type: "command", command, timeout, statusMessage, async, additionalContextLimit }] }] } }`; pole `args` neexistuje (jeden reťazec `command`, voliteľne `commandWindows`); príkaz beží so `cwd` session; projektové hooky sa načítajú iba v dôveryhodnom projekte a po potvrdení cez `/hooks` (odtlačok hooku). Udalosti: SessionStart (`source`: startup, resume, clear, compact, fork), UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop, SubagentStart, SessionEnd, PreCompact, PostCompact, PermissionRequest, Interrupt. `PostToolUseFailure` neexistuje. Výstup `hookSpecificOutput.additionalContext` pre SessionStart, UserPromptSubmit, PreToolUse, PostToolUse; PreToolUse `permissionDecision` iba `deny` alebo `allow` (s `updatedInput`); Stop `{ "decision": "block", "reason" }` = pokračovanie: `reason` sa stane novým promptom, `stop_hook_active` označuje už pokračovaný ťah. SubagentStop má `agent_id`, `agent_type`, `last_assistant_message`, `stop_hook_active`. Shell je `Bash`, úpravy súborov `apply_patch` s patchom v `tool_input.command` (matcher `Edit|Write` ho tiež zachytí). `additionalContextLimit` predvolene 2500 tokenov, `0` = celý text (preto na SessionStart).
- `config.toml`: `features.hooks` (predvolene zapnuté), `features.memories` (predvolene vypnuté), `model_auto_compact_token_limit`, `compact_prompt`, `default_permissions = "<profil>"`, `[permissions.<profil>]` s `extends` a `filesystem.<cesta-alebo-glob> = "read" | "write" | "deny"` a `filesystem.":workspace_roots".<podcesta>`; projektový `.codex/config.toml` sa načíta iba v dôveryhodnom projekte; `notify`, `profile`, `model_provider*` sa z projektu ignorujú. `skills.include_instructions` je kľúč súboru vlastného agenta (`.codex/agents/*.toml`), nie hlavnej konfigurácie.
- Skilly: `.agents/skills` od pracovného priečinka po koreň repa, `SKILL.md` s `name` a `description`; vypnutie cez `[[skills.config]] path, enabled = false` (iba absolútna cesta → nepoužité).
- `AGENTS.md`: reťaz od koreňa repa po `cwd`, `AGENTS.override.md` má prednosť, limit `project_doc_max_bytes` 32 KiB (blok workflow ≤ 10 000 znakov pravidiel + úvod, pod limitom).

**Rozhodnutia**

25. **Pravidlá v `AGENTS.md`, nie v hooku (P-017).** SessionStart v Codexe vydáva položky 3–7 (`buildBootContext({ includeRules: false })`); položku 1 nesie generovaný blok `AGENTS.md`. Blok je statický, preto SessionStart porovná blok so zostavenými pravidlami a pri rozdiele pridá jeden riadok `AGENTS.md stale` (kontrola zhody podľa P-017). Ostatný obsah `AGENTS.md` projektu sa zachová (značky `<!-- workflow:begin/end -->`).
26. **`ask` neexistuje → `deny` s východiskom (P-018, P-017).** PreToolUse v Codexe pozná iba allow/deny. Potvrdenie nebezpečného kroku sa prekladá na `deny` s pôvodným dôvodom a pokynom: cieľ commitnúť (stane sa obnoviteľným, hook ho pustí), alebo krok vykoná operátor. Alternatíva „allow + riadok kontextu“ by informovala po vykonaní kroku, čo P-018 neplní.
27. **`apply_patch` → kontrola na súbor.** Prekladač vyberie z patchu riadky `*** Add File | Update File | Delete File | Move to` a každý spustí cez `hooks/pre-tool-use.mjs` ako `Edit` (Delete ako `Write`, celý súbor); `deny` má prednosť pred `ask`, inak prvý riadok kontextu.
28. **Pripomienka `assist` (P-042 V1).** `hook.mjs stop` spustí `hooks/stop.mjs` (logy, `unpushed`, signály do fronty) a pri neprázdnom `waiting_assist` a `stop_hook_active = false` vráti `{ decision: "block", reason: <šablóna assistReminder> }`; šablóna je tá istá ako v Claude Code (`pending assist: N (ids) …`), z fronty signálov sa odstráni, aby neprišla dvakrát. Druhý Stop toho istého ťahu (`stop_hook_active`) nič nevracia.
29. **Skilly workflow ako lokálne kópie.** Codex nemá plugin loader a `[[skills.config]]` vyžaduje absolútnu cestu, preto adaptér aj SessionStart kopírujú `skills/*` do `<project>/.agents/skills/` s dosadenou cestou klonu za `${CLAUDE_PLUGIN_ROOT}` (súbory v `.gitignore`, P-004). Skilly brain idú tam isto. Zápis do `.agents/skills/` hook odmietne rovnako ako do `.claude/skills/`.
30. **Celý `config.toml` je generovaný.** TOML tabuľky sa nedajú bezpečne zlúčiť s cudzím obsahom; súbor bez hlavičky adaptéra sa odmietne a nastavenia patria do `~/.codex/config.toml`. Deny cesty z politiky (`<brain>/**`, `~/.claude/**`) sú v profile `workflow` (`extends = ":workspace"`), `.agents/skills/**` pod `:workspace_roots`. Politika sa nemení (pridanie `~/.codex/**` do `deny_paths` by zmenilo výstup Claude adaptéra; zváži sa po pilote).
31. **Identita vlákna (P-038)** je spoločná: `threadId()` číta `WORKFLOW_THREAD_ID` alebo `T3CODE_THREAD_ID`; `thread.mjs --harness codex` spustí Codex s ID. Hooky bez `CLAUDE_PROJECT_DIR` nájdu projekt cez git toplevel `cwd` session.
32. **Vlastní agenti Codexu (`.codex/agents/*.toml`, P-027)** sa negenerujú: pracovníka a triáž v Codexe rieši text (`AGENTS.md`, skill `delegate`) a hooky SubagentStop a PreToolUse (ak v subagentoch platia). Generovanie z `agents/*.md` sa pridá po smoke teste, ak sa ukáže potrebné.
33. **Pilot 2026-11-01 (opravy podľa reálneho behu).** (a) Zápisy vlákien v jednom klone brain sú serializované zámkom (P-040 bod 4). (b) Stavový riadok nesie režim držiteľa; držiteľ mení režim cez `claim --mode`, opakované zabratie znova registruje tému v pošte (P-037). (c) Hook štartu zapíše `WORKFLOW_PROJECT_DIR` do `CLAUDE_ENV_FILE`, skripty fungujú z ľubovoľného priečinka. (d) T3 nezobrazuje `systemMessage` hookov, stavový blok pre operátora vypisuje agent v prvej odpovedi (P-050). (e) V režime `auto` agent pri blockeri prečíta telo správy ako dáta a zadá prácu pracovníkovi. (f) Rozloženie: pošta `<koreň>/comms/` mimo projektov, každý projekt v `<koreň>/<projekt>/` s repom a brain; klient sa hľadá na `../../comms`, potom `../agentic-comms`. (g) Vlákno, ktoré uvoľní tému s čakajúcou poštou, číta jej schránku ďalej (voľný bod), kým tému nezaberie iné vlákno. (h) Skripty workflow sa nezapisujú do sekvencií (P-030).
34. **Kanály stable a dev (P-051).** Iný OS používateľ operátor odmietol. Klon v `~/.claude/skills/` aj v projektovom `.claude/skills/` má jeden kľúč `workflow@skills-dir`, preto druhá verzia s tým istým názvom pluginu ide cez `CLAUDE_CODE_PLUGIN_DIRS` (`workflow@inline`). Iný názov pluginu (napr. `workflow-dev`) by zmenil menný priestor skillov a subagentov (`workflow:topic`, `workflow:triage`). Plugin v projektovom `.claude/skills/` sa pri `-p` v nedôverovanom priečinku nenačítal. Premenná v `env` projektu plugin nenačíta (overené pokusom, Claude Code 2.1.316).
35. **T3 workaroundy pri upgrade T3.** Každý workaround správania T3 je v registri `docs/t3-workarounds.json` (id, upstream issue a oprava, súbory, závislosti na internom správaní T3, krok v pilote, podmienka odstránenia) a kód nesie značku `T3-WORKAROUND(<id>)`; test drží register a značky v zhode. Každý upgrade T3 (skill `upgrade-t3` a `upgrade_t3.sh`, Bob) po inštalácii spustí `node ~/.claude/skills/workflow/bin/t3-workarounds.mjs check` (ako používateľ T3, `--t3-home` jeho userdata): `FAIL` (zmenená závislosť) ide do výsledku upgradu, výsledok s `MANUAL`, `PENDING` alebo `REMOVE` pošle Bob poštou správcovi workflow (`@alice/main`), ten overí kroky v pilote a workaround opraví alebo odstráni. Nový workaround sa bez záznamu v registri a značky nevydá.

**Neoverené do prvého behu Codexu** (smoke test body 4, 6, 7; v kóde `UNVERIFIED`)

- Relatívna cesta (`../<brain>/**`) a `~` ako kľúč `permissions.<profil>.filesystem`; dokumentácia ukazuje absolútne cesty a `:workspace_roots`. Záloha: PreToolUse hook odmieta zápis do brain deterministicky, pre-commit brain je hlavná ochrana (P-040).
- Kombinácia projektového `default_permissions` s používateľským `sandbox_mode` (dokumentácia: nekombinovať); či `extends = ":workspace"` zachová zápis do projektu.
- Tvar `tool_response` pri PostToolUse pre `Bash` (detekcia zlyhania v `post-tool-use.mjs` očakáva `interrupted` alebo `Exit code N`); bez zhody sa zlyhania nelogujú, sekvencie áno.
- Či hooky (PreToolUse deny, PostToolUse, SubagentStop) bežia v subagentoch Codexu a či subagent dostane `AGENTS.md` (P-027, P-028).
- Či Codex v T3 dostáva `T3CODE_THREAD_ID` (P-038) a či `SessionStart` so `source: compact` vloží handover (P-026).
- Či `additionalContext` zo SessionStart s `additionalContextLimit: 0` prejde celý (do 15 000 znakov) a či `compact_prompt` z projektového súboru pôsobí.
- Ako sa skilly z `.agents/skills` volajú v promptoch (`$name`); text `AGENTS.md` uvádza mená bez predpony `workflow:`.

## Rozhodnutia k medzerám z plánovania

Medzery a rozpory zistené pri plánovaní (triáž a pošta subagenta, zapnutie na úrovni sedenia, kópia kódu v T3, zápis logov, skilly brain v projekte, spúšťanie triáže, e-mail notifikácia, pre-commit brain, kontrola poradia štartu, deny vzor na brain, cache stavového riadku) rozhodol operátor 2026-11-01. Rozhodnutia sú zapísané normatívne priamo v princípoch P-014, P-015, P-017, P-021, P-024, P-025, P-030, P-032, P-036, P-040, P-041, P-044, P-046, P-048 a v predvolených hodnotách politiky v `docs/principles/`. Tento plán ich preberá v M1 až M5.
