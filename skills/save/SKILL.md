---
name: save
description: Použi vždy, keď sa má niečo uložiť do brain – operátor povie „ulož“, „zapamätaj si“, „volám sa…“, „páči sa mi to“, alebo workflow vyžaduje zápis (rozhodnutie, handover, výnimka, skill z chyby alebo rutiny). Jediný vstupný bod zápisu.
argument-hint: "[memory|decision|rule|exception|skill|handover] ..."
---

# save – jeden vstupný bod zápisu (P-013, P-007)

Zápis do brain ide výlučne cez `node ${CLAUDE_PLUGIN_ROOT}/bin/save.mjs`. Write/Edit do brain sú zakázané.

## 1. Klasifikácia (tvoj úsudok, v tomto poradí, prvá zhoda vyhráva)
1. Postup (kroky, ako niečo urobiť) → `skill`
2. Mení správanie agenta (MUSÍ/NESMIE, „odteraz rob…“) → `rule`; ak operátor mení platný princíp → `exception`
3. Voľba medzi alternatívami → `decision`
4. Obsah s hodnotou sám o sebe (zoznam, text, výstup pátrania, report) → dokument v projekte, nie brain (bez save); v persone `docs/<vec>/` zapísaný priamo a commitnutý `save.mjs docs [--message "..."]`, nie `scratch/` (je gitignorovaný a dočasný)
5. Stav nedokončenej práce → `handover`
6. Inak opisný fakt o subjekte → `memory`

Pri nejednoznačnosti sa opýtaj operátora, nehádaj. „Toto ulož“ = posledný výstup agenta, ak nie je jasné, opýtaj sa.

## 2. Zápis (skript, deterministicky)
- `save.mjs memory <type> <name> --content "..." [--origin operator|derived|observed] [--aliases a,b] [--relates-to x] [--sources f1,f2]`
  typy: operator, project, service, tool, person, environment. Kľúč `<type>-<name>` tvorí skript; existujúci subjekt sa prepisuje. Podobný kľúč skript odmietne a vypíše ho: zvoľ existujúci názov alebo `--new`.
  `derived` vyžaduje `--sources` (odtlačok pre P-009). Zapisuj záver (1–3 vety) a zdroje, nie kópiu zdroja.
- `save.mjs decision "<title>" --what "..." --alternatives "..." --reason "..." --relates-to <súbor|vec>` → ID D-XXXX; uveď ho v commite zmeny. Nahradenie: `--supersedes D-XXXX`.
- `save.mjs rule <name> --content "..." --enforced-by <súbor>[:<symbol>]` (pravidlo projektu, krátke, normatívne: iba MUSÍ/NESMIE alebo odkaz na skill; kroky a príkazy skript odmietne, patria do skillu, P-007). Pravidlo MUSÍ menovať kód, ktorý porušenie zablokuje (hook, skript, test; súbor vo workflow, projekte alebo brain, symbol sa v ňom musí nachádzať): najprv ten kód (skill `fix` alebo hlásenie správcovi workflow), potom pravidlo. Nové pravidlo prejde bránou: sudca (lacný model) ho porovná so všetkými pravidlami workflow a projektu; prekryv → rozšír existujúce pravidlo (alebo `--distinct "<id>: <čím sa líši>"`), rozpor → najprv oprav to pravidlo, vynútiteľné kódom → urob kód a pravidlo vynechaj (`--needs-text "<prečo to agent musí vedieť vopred>"`), prekročený limit → zamietnuté. `--unenforced "<prečo to kód nevie>"` iba pri úprave existujúceho pravidla. Nie nové pravidlo k starému, lebo pravidiel pribúda bez konca a práca sa nezlepší (operátor 2026-11-03). Prepis pravidla zaznamenané vynútenie zachová. Nie pravidlo iba v texte, lebo agent ho pod tlakom zadania vynechá (operátor 2026-11-02); `--remove --reason "nahradené P-XXX"` zmaže pravidlo projektu, ktoré pokrýva pravidlo workflow (nie duplikát, P-007).
- Cieľový brain je brain projektu session (nie podľa `cd`). Z priečinka iného projektu s vlastným brain skript odmietne: daj `--project <cesta>` toho projektu, do ktorého patrí zápis (platí aj pre `topic` a `done`).
- `save.mjs exception P-XXX --wording "..." --reason "..." [--layer project|harness|machine|local]`; nemenné princípy skript odmietne.
- `save.mjs skill <name> --description "Použi, keď ..." --content "..." --origin error|routine [--from-procedure <n>] [--from-sequence <s>] [--script <súbor>[,<súbor>]]`; `--script` uloží skript (.mjs/.js/.sh/.py, ≤ 64 KB) vedľa SKILL.md v tom istom commite gitu brainu a nasadí sa so skillom (skript v inom jazyku teda nepatrí do `tools/` projektu; .py spúšťa `python3`, na Windowse `python`, a Python musí byť na stroji); skript zdroj ber z `<projekt>/scratch/` (úprava existujúceho skriptu: prečítaj ho Read a celý zapíš Write do `scratch/`, nie `cp`/úprava v `skills/` ani `.claude/skills/`, lebo deny pravidlá Edit tieto cesty zamietnu aj v príkaze shellu a cieľ ostane zamknutý do správy operátora, alice 2026-11-07) a v texte skillu ho volaj absolútnou cestou, ktorú save vypíše (`script runs as: node|sh|python3 <projekt>/.claude/skills/<name>/<skript>`), nie `node <skript>` relatívne; existujúci skill pre ten istý nástroj sa refaktoruje, nový nevznikne: prečítaj jeho telo, novú vedomosť zapracuj do celku a ulož celé telo `--content "..." --replace` (bez `--replace` save odmietne a vypíše súčasné telo); nie pripojenie ďalšej sekcie, lebo skill sa tak stane zlepencom pokynov, ktoré sa opakujú alebo si odporujú (operátor 2026-11-08). Úprava časti tela: `save.mjs skill <name> --sed 's/<vzor>/<náhrada>/[gim]'` (regex JavaScriptu, `\n` v náhrade = nový riadok; description a origin ostanú; bez zhody nič nezmení), nie awk + `--replace` s opísanou description. `--description` zadaj bez úvodzoviek navyše. `--remove --reason "nahradené workflow:<skill>"` zmaže skill projektu aj s jeho skriptmi (duplikát skillu workflow, P-007). Skill operátora sa nemení, iba navrhne.
- Vedomosť jedného repa domény (jeho opis, runbook, rozhodnutie, skill, stav projektu) → pridaj `--repo [<repo>]` k `memory`, `decision`, `skill` (iba agentic) alebo `handover --repo <repo> --file <súbor>|--content "..."` (`<repo>/agentic/HANDOVER.md`, stav projektu; handover témy ostáva v brain). Bez mena = repo session. Zápis ide do worktree tvojej kódovej témy repa, inak commitom do `knowledge_branch` repa (bez pushu). Vedomosť persony, ľudí, prostredia alebo viacerých rep ostáva v brain; kľúč `project-<repo>` v brain skript odmietne (`--brain "<dôvod>"` výnimka). Rozhodnutie repa sa odkazuje `<repo>/D-0001`. Záznam z brain do repa: `save.mjs move <cesta> --repo <repo> [--dry-run]`. Do `<repo>/agentic/` nepíš Write ani shellom (hook zamietne).
- `save.mjs handover <topic> --task "..." --done "a; b" --next "..." --files "a; b" --questions "a; b"` (15 riadkov, iba držiteľ témy: nadpisy, `--task` a `--next` zaberú 7, položky `--done`, `--files` a `--questions` spolu najviac 8, každá položka oddelená `;` je riadok).

## 3. Písanie skillu (pred `save.mjs skill`)
- Description je iba trigger: „Použi, keď <situácia>.“ (jedna veta, bez postupu). Ak operátor postup spúšťa slovom („done“, „hotovo“), uveď aj tú frázu v úvodzovkách. Ak sa dá situácia zameniť (fráza ako zdôraznenie vo vete), pridaj, kedy skill NErobiť.
- Autonómia: napíš, čo smie agent urobiť bez pýtania („rozhodni sám a vypíš do výsledku“), a menuj blockery, pri ktorých sa pýta (P-059). Skill bez toho vedie k otázkam „mám pokračovať?“.
- Postup s opakovaním (review, oprava, overenie): rozpočet kôl, skorý koniec (zostali iba nity), stav „uviazol“ (spor po dvoch odpovediach rozhodne operátor) a záznam kôl (id, výsledok, nehádaj chýbajúce). Vyčerpaný rozpočet nie je schválenie.
- Žiadne pevné ID modelu ani verzie: skill povie, ako ich zistiť za behu (politika, `orchestrator_capabilities`), a ak ich nemá, nahlási blocker, nenahrádza ich iným.
- Dôvod patrí k pokynu: „nie X, lebo Y (dátum)“. Skript iba tam, kde je krok deterministický (čakanie, commit, vydanie); ostatné ostáva textom.
- Pred novým skillom hľadaj existujúci (`error.mjs` / `find`): refaktoruj ho, nezakladaj druhý. Refaktor: celé telo ako jeden postup (kroky v poradí práce, každý pokyn raz, žiadne dva pokyny proti sebe, dôvody „nie X, lebo Y“ zachované); staré sekcie „## Doplnenie“ pri tom zlúč do tela.

Skript po zápise commitne so značkou, pushne, vygeneruje indexy a hlási `unpushed: N` alebo prekročený limit (vtedy `workflow:consolidate` po dokončení práce).

Príklad: „Volám sa Anna“ → `save.mjs memory operator operator --content "name: Anna"`; druhýkrát ten istý príkaz prepíše záznam.
