# Princípy workflow (špecifikácia)

Zdroj pravdy pre tento workflow je tento priečinok (`docs/principles/`) v repe `agentic-flow`. Vznikol prevzatím sekcií „Dohodnuté princípy“ a „Predvolené hodnoty politiky“ zo zápiskov operátora (stav 2026-11-01, P-001 až P-053 vrátane rozhodnutí k medzerám z plánovania, bez otvorených výhrad). Mená osôb, konkrétne cesty a názvy služieb z príkladov sú zovšeobecnené (P-004); názvy harnessov a prostredí (Claude Code, Codex, T3), pre ktoré existujú adaptéry, ostávajú, lebo sú to mechanika, nie dáta inštancie.

Zmena princípu sa robí v jeho súbore, vo vývojovej vetve, a workflow sa z princípov odvodí nanovo (ZAMER: vždy nanovo, nikdy iterácia).

Konvencie zápisu: `<brain>` je koreň brain repa (P-024), `<plugin>` je koreň klonu workflow (`~/.claude/skills/workflow/`, P-048), `<project>` je koreň projektu. Technické identifikátory sú anglické (P-049). Príkazy a skripty sú iba Node.js (P-034).

## Dohodnuté princípy

Každý princíp je v samostatnom súbore `P-NNN.md`. Agent číta jeden súbor, ktorý potrebuje (dôvod pravidla, ktoré nie je jasné); celý priečinok sa neprehľadáva (hook to zamietne). Krátke normatívne znenie je v `rules/`.

## Zoznam

- [P-001](P-001.md): Otrava kontextu (context poisoning)
- [P-002](P-002.md): Prekročenie rozsahu (scope creep)
- [P-003](P-003.md): Chyba sa stáva skillom (error-to-skill)
- [P-004](P-004.md): Agnostický workflow (project/agent/session-agnostic)
- [P-005](P-005.md): Opakovaná činnosť sa stáva skillom (procedure crystallization)
- [P-006](P-006.md): Opakovaná vedomosť sa stáva pamäťou (knowledge crystallization)
- [P-007](P-007.md): Jednoznačné smerovanie vedomosti (knowledge routing)
- [P-008](P-008.md): Evidencia rozhodnutí (decision record)
- [P-009](P-009.md): Overovanie pamäte podľa pôvodu (memory staleness)
- [P-010](P-010.md): Limit indexu a triedenie pamäte (memory consolidation)
- [P-011](P-011.md): Handover (prenos rozpracovanej práce)
- [P-012](P-012.md): Jednotka práce a odbočenie z témy (unit of work, topic drift)
- [P-013](P-013.md): Jeden vstupný bod zápisu (single writer)
- [P-014](P-014.md): Lokálnosť mechanizmov (no global state)
- [P-015](P-015.md): Vynútenie cez nastavenia repozitára (settings as enforcement)
- [P-016](P-016.md): Distribúcia a aktualizácia workflow (workflow as submodule)
- [P-017](P-017.md): Jeden zdroj, adaptéry pre harnessy (harness adapters)
- [P-018](P-018.md): Ochrana dát (destructive operations)
- [P-019](P-019.md): Overené podklady pre rozhodnutie (grounding)
- [P-020](P-020.md): Overenie práce (verification)
- [P-021](P-021.md): Štartovacia sekvencia (boot sequence)
- [P-022](P-022.md): Rozpočet štartovacieho kontextu (context budget)
- [P-023](P-023.md): Vkladanie do kontextu počas session (mid-session injection)
- [P-024](P-024.md): Oddelenie mechaniky a dát (workflow vs. brain)
- [P-025](P-025.md): Dve roly (main agent, worker)
- [P-026](P-026.md): Kompakcia a pokračovanie (compaction, continuation)
- [P-027](P-027.md): Pracovník bez workflow (worker isolation)
- [P-028](P-028.md): Cyklus chýb pracovníka (worker error loop)
- [P-029](P-029.md): Základné skilly (base skills)
- [P-030](P-030.md): Neagentické sekvencie sa stávajú skillom so skriptom (command sequence crystallization)
- [P-031](P-031.md): Deterministické vyhľadávanie v brain (`find`)
- [P-032](P-032.md): Umiestnenie skillov podľa autora (skill ownership)
- [P-033](P-033.md): Jednotka práce vo worktree (worktree per unit of work)
- [P-034](P-034.md): Spustiteľné časti workflow v Node.js (single cross-platform runtime)
- [P-035](P-035.md): Vrstvy pravidiel a výnimky (layered exceptions)
- [P-036](P-036.md): Téma ako jednotka práce (topic)
- [P-037](P-037.md): Držiteľ témy (topic holder)
- [P-038](P-038.md): Identita vlákna (stable thread identity)
- [P-039](P-039.md): Spoločné dáta ako samostatné súbory, indexy sa generujú (derived indexes)
- [P-040](P-040.md): Zápis a synchronizácia brain (brain write and sync)
- [P-041](P-041.md): Pošta ako samostatná služba (comms service)
- [P-042](P-042.md): Úroveň správy podľa blokovania odosielateľa (message urgency)
- [P-043](P-043.md): Budenie ako samostatný modul (wake-up module)
- [P-044](P-044.md): Doručenie bez kontaminácie kontextu (riadky ID, bez textu)
- [P-045](P-045.md): Granularita a adresovateľnosť tém (topic granularity)
- [P-046](P-046.md): Oznamy operátorovi bez modelu (operator notices)
- [P-047](P-047.md): Správa nie je pokyn operátora (message is data)
- [P-048](P-048.md): Distribúcia workflow ako plugin v priečinku skillov používateľa (skills-dir plugin)
- [P-049](P-049.md): Technické identifikátory v angličtine (english identifiers)
- [P-050](P-050.md): Stav vlákna a voľba témy pri štarte (session start topic prompt)
- [P-051](P-051.md): Stabilná verzia a vývojový kanál na jednom stroji (release channels)
- [P-052](P-052.md): Izolácia pracovných súborov (project-local scratch)
- [P-053](P-053.md): Lacný model pre pracovníkov (subagent model default)
- [P-054](P-054.md): Zamietnutý príkaz (denied command)
- [P-055](P-055.md): Kanál medzi agentmi (no direct thread send)
- [P-056](P-056.md): Požiadavka na operátora (operator request) – nahradený P-061
- [P-057](P-057.md): Práca sa nezastaví, čakanie iba s budíkom (work never stops, self-armed waker) – nahradený P-061
- [P-058](P-058.md): Operátor nie je vykonávateľ (no operator chores)
- [P-059](P-059.md): Otázka iba ako blocker (no needless check-ins)
- [P-060](P-060.md): Stručná odpoveď (concise answer) – nahradený P-061
- [P-061](P-061.md): Protokol odpovede (reply protocol)
- [P-062](P-062.md): Materiály témy (topic materials)
- [P-063](P-063.md): Zámer operátora (operator intent)
- [P-064](P-064.md): Otázky vlákna témy idú orchestrátorovi (orchestrator questions)

## Predvolené hodnoty politiky

Hodnoty určil agent (operátor delegoval rozhodnutie, 2026-10-31). Sú to východiskové hodnoty v `policy.json` workflow (P-017); projekt ich dopĺňa v `<brain>/policy.json`. Dajú sa upraviť bez zmeny princípov.

| Premenná | Hodnota | Princíp | Zdôvodnenie |
|---|---|---|---|
| Index pamäte | najviac 50 riadkov | P-010, P-022 | 1 riadok na subjekt, dosť pre projekt, malá záťaž kontextu |
| Index rozhodnutí | najviac 50 riadkov | P-008, P-022 | rovnaká logika ako pri pamäti |
| Pravidlá (jadro a všetky vrstvy spolu, po zostavení) | najviac 200 riadkov a 10 000 znakov | P-022, P-035 | odporúčanie dokumentácie Claude Code |
| Stavový riadok vlákna | 1 riadok | P-021, P-023 | identita, téma, počet správ |
| Zoznam otvorených tém | najviac 10 riadkov | P-011, P-021, P-022 | viac súbežných tém naraz je signál na upratanie |
| Popis skillu | najviac 300 znakov | P-022 | popis je trigger, nie návod |
| Štartovací kontext bez zoznamu skillov | najviac 9 500 znakov na výstup hooku, pravidlá v častiach do 9 000 | P-022 | harness z jedného výstupu hooku vloží najviac 10 000 znakov, väčší iba ako náhľad 2 KB |
| Zoznam skillov (súčet popisov) | najviac 6 000 znakov | P-022 | zhruba 20 skillov |
| Handover | najviac 15 riadkov | P-011 | už určené v P-011 |
| Signál hooku počas session | najviac 2 riadky | P-023 | už určené v P-023 |
| Netriviálna zmena: odstránené riadky | viac ako 50 riadkov alebo viac ako polovica súboru | P-018 | zachytí prepis, nezachytí bežnú opravu |
| Netriviálna zmena: počet súborov | viac ako 5 súborov v jednej operácii | P-018 | hromadná operácia |
| Okno kompakcie | 200 000 tokenov | P-026 | kvalita pri veľkom okne klesá skôr, ako sa naplní |
| Okno rotácie `sequences.log`, `procedures.log`, `derivations.log` | 30 dní | P-005, P-006, P-030 | opakovanie má zmysel v rozumnom čase |
| Vek nespracovaného zlyhania pre signál | 7 dní | P-030 | týždeň bez spracovania je zabudnuté poučenie |
| Prah opakovania sekvencie a postupu | 3 výskyty (sekvencia: 3 rôzne sessions) | P-005, P-030 | určil operátor |
| Prah opakovania odvodenia | 2 výskyty | P-006 | druhé odvodenie už je plytvanie |
| Výsledok subagenta | najviac 3 000 znakov (vynúti SubagentStop) | P-027 | záver so zdrojmi, nie obsah |
| Limit zobudení | 6 za hodinu na dvojicu tém, stop pri 2 rovnakých správach za sebou | P-043 | slučku prezradí skôr opakovanie než počet |
| Čakanie hooku na poštu | najviac 2 s | P-041 | výpadok pošty nesmie spomaliť ťah |
| Počet správ pre stavový riadok | živo; po výpadku posledná hodnota a nový pokus najskôr po 60 s | P-041, P-023 | výpadok nesmie spomaliť každý prompt |
| Režim držiteľa | `operator` | P-037 | bezpečnejšie predvolenie |
| Notifikácia pri `blocker` | e-mail cez `notify.command`; bez neho iba stránka oznamov | P-046 | určil operátor |
| Umiestnenie brain | `../<nazov-brain>` relatívne k projektu | P-024 | brain vedľa projektu, bez absolútnych ciest |
| Kópia kódu témy | `../<project>-topics/<id>/` | P-036 | vždy samostatný klon vedľa projektu, aj v T3 |
