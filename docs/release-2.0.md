# Vydanie 2.0: postup prechodu

Postup vydania workflow 2.0 a prechodu domén na dáta 2.1 (špecifikácia flow v2, kap. 11; implementačný plán, časť 2). Kód 2.0 nemá vrstvu spätnej kompatibility: nečíta handover bez šiestej sekcie, polia 1.8 (`orchestrator`, `fix_gate`, `topics.auto`, `knowledge_branch`) ani `materialy.mjs`. Nemá ani nástroj návratu polí v2. Projekty sa preto migrujú na dáta 2.1 hneď pri vydaní, ešte pred spustením vlákien. Pilot v dátach 2.0 sa nerobí.

`<plugin>` je checkout workflow vo verzii 2.0.0. Pred prepnutím inštalácie je to checkout repa na tagu `v2.0.0`, potom inštalácia, ktorú vypíše `brain.mjs pin`. `<root>` je koreň projektov stroja (`project.mjs root`).

Pošta sa nemení. Vydanie 2.0 má `commsModel: 2` ako 1.8, takže pošta 0.5.0 je kompatibilná a novú verziu pošty netreba (11.11.2, P-073). Pošta neodmietne ani klienta 1.8. Starší stroj preto zastaví iba to, že sa vlákna spustia až po aktualizácii všetkých strojov (krok 3).

## 0. Osoby (pred vydaním, 11.8)

Kód 2.0 odmieta nový zápis osoby do `memory/`. Preto treba najprv zozbierať osoby do repa operátora.

1. `node <plugin>/bin/people.mjs collect --out <plán.json>` vytvorí zoznam osôb zo všetkých brainov.
2. Operátor zoznam schváli.
3. `node <plugin>/bin/people.mjs collect --apply <plán.json>` zapíše osoby jedným commitom do repa operátora.

Brána: zoznam je schválený a commitnutý.

## 1. Kontrola pripravenosti (na každom stroji)

Na každom stroji spusti `node <plugin>/bin/overview.mjs --pre-release [--root <root>]`. Kontrola prejde všetky brainy všetkých domén stroja a nič nezapisuje. Pri náleze skončí s kódom 1. Nálezy:

- živá téma bez kroku (Ďalší krok) a bez otázky (Otvorené otázky): ulož handover (`save.mjs handover <téma> --next "<krok>"`, inak otázka);
- práca témy, ktorá nie je na origin:
  - lokálna vetva `topic/<téma>` alebo `topic/<téma>--<úloha>`, ktorej commity origin nemá: pushni ju príkazom z riadku nálezu;
  - necommitnuté zmeny vo worktree témy alebo úlohy: commitni ich a pushni;
- otvorená správa, ktorú 2.0 nespracuje: otázka na schválenie fixu (P-075) alebo práca odovzdaná inej téme (P-055, `handoffs.json`). Uzavri ju odpoveďou (`comms send --reply-to <id> --state hotovo`, `comms settle --id <id>`) alebo ju stiahni (`comms withdraw --id <id>`);
- pošta neodpovedá: kontrola správ neprebehla, zopakuj ju, keď pošta odpovedá;
- brain v dátach 1: najprv ho migruj na dáta 2.0 (`node <plugin>/bin/migrate.mjs <brain>`, potom `--apply`). Kód 2.0 potrebuje aspoň dáta 2.0 (O22).
- zvyšky mimo gitu v priečinkoch starších dát (`scratch/`, `materialy/`, `docs/`, `temy/` …). Ostávajú aj na stroji, ktorý presun iba stiahol cez pull:
  - generované súbory (`__pycache__`, `*.pyc`, `.DS_Store`) odstráni `migrate.mjs <repo> [--to 2.1] --check --fix`;
  - ostatné súbory triedi operátor po položkách, s veľkosťou a počtom súborov. Čo netreba, zmaže. Prácu presunie do pracovného priečinka jej témy;
- pracovné súbory mimo gitu (`topics/<téma>/tmp/`) nad 500 MB v jednom repe: nález vymenuje najväčšie priečinky a súbory. Exporty, zálohy a kópie, ktoré netreba, sa zmažú so súhlasom operátora. Hotové dielo patrí do `vystupy/` alebo `zdroje/`. Rovnaký nález hlási aj prehľad supervisora.

Kontrola vypíše aj riadky, ktoré nie sú nálezy:

- handovery bez sekcie `## Úlohy pre operátora` (pridá ju migrácia, krok 4);
- politika, ktorej `topics.auto.projects` 2.0 už nečíta (`topics.shared_checkouts` prenesie migrácia, krok 4);
- každá doména, ktorá ešte nie je v dátach 2.1, s jej repami a s presnými príkazmi migrácie. Tieto príkazy sa použijú v kroku 4.

Brána: kontrola skončí bez nálezu na všetkých strojoch.

## 2. Zastavenie vlákien (11.4, 11.9)

Na všetkých strojoch: každé vlákno uloží handover (s krokom alebo otázkou) a pushne vetvy svojich tém. Potom sa vlákna zastavia. Kontrolu z kroku 1 spusti znova až po zastavení: musí skončiť bez nálezu.

## 3. Aktualizácia workflow na všetkých strojoch (11.11.2)

Na každom stroji spusti `node <plugin>/bin/brain.mjs pin v2.0.0 --all`. Inštalácia sa prepne pri ďalšom štarte session. Do spustenia vlákien (krok 6) sa v žiadnej doméne nepracuje.

Brána: verzia 2.0.0 je na každom stroji pred prvým vláknom.

## 4. Migrácia domén na dáta 2.1 (11.5, 11.9)

Migruj po jednej doméne, celú doménu naraz: brain a každé repo projektu, ktoré ho menuje. Domény migruj v poradí pilot, doména supervisora (bod 12 nižšie), ďalšie domény. Ak doména zlyhá, ďalšia sa nezačne. Pre každú doménu použi príkazy z výstupu kroku 1:

1. Repo v dátach 1 najprv: `node <plugin>/bin/migrate.mjs <repo> --apply`. Veľký `scratch/` (nad 100 MB alebo nad 500 súborov) náhľad rozdelí na položky triáže, každú s veľkosťou a bez návrhu. Celý ho nepresunie do `temy/main/tmp/`, kým operátor nepotvrdí riadok `scratch/`.
2. Náhľad a tabuľka triáže: `node <plugin>/bin/migrate.mjs <brain> --to 2.1 --write-triage <tsv>`. Operátor potvrdí riadky:
   - výstupy brainu: `<repo>:vystupy/<typ>/`;
   - zdroje brainu: `<repo>:zdroje/<téma>/` alebo `pomocne`;
   - presuny do brainu inej domény: `<cesta k brainu>:topics/<id>/`, `:skills/agentic/<meno>/`.

   Pravidlá a poučenia s P-050, P-055, P-064, P-075 a fakty o osobách, ktoré `people.mjs collect` neprenieslo, idú do `--approve <tsv>` (`zmazat`, `prepisat <súbor>`).
3. Presun: `node <plugin>/bin/migrate.mjs <brain> --to 2.1 --apply --confirmed <tsv> [--approve <tsv>]`. Vznikne jeden commit v každom repe a nič sa nepushne. Zlyhanie vráti všetky repá. Migrácia:
   - pridá do handoverov šiestu sekciu;
   - prenesie `topics.auto.projects` do `topics.shared_checkouts` (relatívne k doméne);
   - zapíše `default_repo` ako meno repa;
   - zmení `knowledge_branch` na `target_branch`;
   - presunie rozhodnutia repa projektu z `vystupy/rozhodnutia/` do `.brain/decisions/` a prepíše odkazy na ne v repe aj v braine.
   - presunie pracovné súbory mimo gitu k ich téme v braine. Priečinok nad 100 MB alebo nad 500 súborov náhľad zastaví: operátor ho najprv roztriedi, alebo presun schváli riadkom `<repo>:<cesta>/<TAB>presunut` v `--approve`;
   - odstráni generované súbory mimo gitu v priečinkoch starších dát. Ostatné súbory mimo gitu, ktoré presun nevezme (napríklad `scratch/` dát 1), náhľad zastaví, kým ich operátor neroztriedi.
4. Kontrola: `node <plugin>/bin/migrate.mjs <brain> --to 2.1 --check`. Musí skončiť bez nálezu a s jedným migračným commitom v každom repe. Nálezom je aj každý zvyšok mimo gitu v priečinku starších dát. `--fix` pregeneruje zastaraný `INDEX.md` a odstráni generované súbory. Potom pushni repá, ktoré výstup vymenuje.
5. Iné stroje: urob pull klonov domény ešte pred spustením vlákien. Štart session v repe, ktorého dáta nesedia s brainom domény, sa odmietne s príkazom na pull.

Bod 12 (doména supervisora a doména workflow):

1. Nová doména: `mkdir <root>/<doména> && touch <root>/<doména>/.agentic-domain`, potom `node <plugin>/bin/brain-init.mjs <root>/<doména>/brain --layout 2.1 --remote <url>`. Nové repo zakladaj iba so súhlasom operátora.
2. Témy a poučenia vývoja presuň riadkami TSV `<cesta>\t<doména>/brain:<cieľ>` v tom istom `--apply`. Cesta ku kópii kódu (`copy`) presunutej témy sa prepíše na `.worktrees/` novej domény.
3. Repá projektu presuň do novej domény spolu s ich `.worktrees/<repo>/`:
   - `mv` a v každom repe `git worktree repair`;
   - v `.workflow.json` každého repa nastav `brain: ../brain` (commit v kódovej téme);
   - v každom repe spusti `adapter.mjs claude-code --brain ../brain`;
   - prepoj projekty v T3.
4. V politike nového brainu nastav `topics.shared_checkouts` na repá projektu a `default_repo`.
5. Adresát hlásení: nič v braine. Hlásenia chýb idú do vlákna T3 správcu, ktoré má server pošty v `instance.json` (`maintainer.thread`); repo pre issue mení iba `brain.mjs maintainer --repo <url>|none`. Supervisor: `brain.mjs supervisor --persona <persona> --comms <adresa>` v každom braine.

## 5. Overenie domény (11.10; plán 2.2)

Každá kontrola je pozorovanie (P-020), nie výsledok testu. Overenie beží na skúšobnej téme, ktorej commity sa pri návrate vracajú spolu s migračným.

| Čo overiť | Postup | Čo musí byť vidieť |
|---|---|---|
| `migrate --check` | po `--apply` v každom repe domény | bez nálezu; jeden migračný commit na repo |
| iný stroj | pull klonu domény pred spustením vlákien | štart session prejde; pred pullom ho workflow odmietne pre nezhodu dát |
| štart session | nové vlákno v doméne | blok „Dáta tohto repa“ ukazuje dáta 2.1, načítaný profil operátora z `osoby/` |
| vyhľadanie osoby | `people.mjs find <alias> --domain` | jedna zhoda pre známy alias, prenesené fakty z `memory/` sú v `osoby/` |
| triáž pri `done` | skúšobná téma s výstupom a zdrojom, `done --topic` | výstup vo `vystupy/<typ>/` cieľového repa s témou v hlavičke, `topics/<topic>/` odstránený, INDEX aktuálny |
| stav čítaný supervisorom | `overview.mjs` | stav skúšobnej témy z `topics/<topic>/.tema.json` |

Ak riadok neprejde alebo `--check` nájde chybu, migrácia domény zlyhala. Pred spustením vlákien sa so súhlasom operátora vráti:

1. `node <plugin>/bin/migrate.mjs <brain> --to 2.1 --revert-list` vypíše migračný commit a commity skúšobnej témy.
2. Príkazy `git revert` z výpisu spusti v každom repe. Revert je nový commit a históriu neprepisuje.

Zlyhaná doména zastaví poradie. Po spustení vlákien sa nevracia nič: chyba sa opraví ďalším commitom alebo novou verziou.

## 6. Spustenie vlákien

Po overení domény sa vlákna spustia nanovo a pokračujú z handoveru (krok alebo otázka). Ďalšia doména začína krokom 4.
