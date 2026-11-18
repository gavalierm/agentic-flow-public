# workflow (agentic-flow)

Plugin pre Claude Code, ktorý dáva agentovi pevné pravidlá práce, základné skilly a skripty na prácu s „brain“ (pamäť, rozhodnutia, témy, handover). Jeden klon na stroji, zapína sa osobitne v každom projekte. Princípy, z ktorých workflow vychádza, sú v `docs/principles/`. Plán implementácie a nasadenia pilotu je v `PLAN.md`.

Stav: M1–M3 hotové (brain, témy, štart, stavový riadok, hooky, skilly `save`, `find`, `topic`, `done`, `error`, `delegate`, `consolidate`), M5 hotové (pošta vo workflow: stavový riadok `mail: n`, skill `comms`), M6 hotové (budenie cez T3, repo `agentic-comms`), M7 hotové (adaptér Codex; funkčnosť v Codexe overí smoke test pilotu). Pošta sama (M4) je v repe `agentic-comms`.

## Čo to je

- **Workflow** (tento repozitár) je mechanika: pravidlá, skilly, hooky, skripty. Neobsahuje nič o konkrétnom projekte ani človeku.
- **Brain** je samostatné git repo s dátami jedného projektu: pamäť, rozhodnutia, pravidlá projektu, skilly projektu, témy. Leží vedľa projektu (predvolene `../<nazov-brain>`).
- **Projekt** je tvoje repo. Workflow sa v ňom zapne dvoma malými súbormi (`.claude/settings.json`, `.workflow.json`).
- **Pošta a budenie** (správy medzi agentmi) sú samostatný repozitár `agentic-comms`; na základnú prácu nie sú potrebné. Workflow ju použije, keď ju nájde (pozri „Pošta“).

## Ako to funguje (v kocke)

```mermaid
flowchart TB
  OP["<b>Operátor</b><br/>zadá úlohu slovami, rozhoduje iba to,<br/>čo agent rozhodnúť nesmie"]

  subgraph PA["Projekt A (priečinok)"]
    direction LR
    BA[("Brain (git)<br/>pamäť projektu")]
    DA[("Projekt (git)<br/>súbory a dáta")]
  end
  subgraph PB["Projekt B (priečinok)"]
    direction LR
    BB[("Brain (git)<br/>pamäť projektu")]
    DB[("Projekt (git)<br/>súbory a dáta")]
  end

  subgraph AG["Agent pracuje na jednej úlohe (téme) v jednom projekte"]
    direction LR
    S1["1. Načíta brain<br/>pravidlá, rozhodnutia,<br/>kde minule skončil"] --> S2["2. Pracuje v projekte<br/>mení súbory a dáta,<br/>hľadanie dá pomocníkom"] --> S3["3. Zapíše do brainu<br/>čo urobil, čo ďalej,<br/>čo sa naučil"]
  end

  OP --> AG
  BA -. číta .-> S1
  S2 -. mení .-> DA
  S3 -. zapisuje .-> BA
```

- **Priečinok** je obyčajný obal a nič si nepamätá. **Git** sú súbory s celou históriou zmien a zálohou. Každý projekt je priečinok s dvoma oddelenými repami vedľa seba: brain (pamäť) a samotný projekt (súbory a dáta).
- **Roly:** operátor (ty) dáva smer a schválenia; supervisor zakladá vlákna, dáva pokyny poštou a číta stav tém; manažér témy (jedno vlákno, jedna téma) vedie tému v rozsahu jej Zadania; subagent robí jeden task. **Pošta:** pokyny supervisora, otázky a hlásenia chýb workflow. **Budík:** zobudí agenta, keď má pokračovať. **Strážcovia (hooky):** kontrolujú kostru a stav záverečnej odpovede (text výsledku nečítajú), aby ťah neskončil bez budíka ani bez otázky, ktorú treba položiť.

```mermaid
flowchart LR
  E["<b>Chyba</b><br/>niečo zlyhá alebo operátor<br/>povie „to je zle“"] --> K["<b>Skill</b><br/>agent zapíše do brainu návod:<br/>„v tejto situácii rob toto, nie tamto“"] --> N["<b>Automaticky nabudúce</b><br/>v podobnej situácii sa návod<br/>agentovi načíta sám"]
  K -. platí všade .-> R["<b>Spoločné pravidlá</b><br/>novú verziu dostanú všetci<br/>agenti vo všetkých projektoch"]
```

## Predpoklady

- **git**
- **Node.js 22 alebo novší** (`node --version`). Claude Code Node neobsahuje; na Windowse ho stiahni z nodejs.org (inštalátor LTS) a reštartuj terminál.
- **Claude Code** nainštalovaný a prihlásený.
- **Windows:** Git for Windows (dodá `git`). Príkazy nižšie sú pre PowerShell.

## Inštalácia

Workflow sa klonuje presne do priečinka `skills/workflow` v nastaveniach Claude Code. Claude Code ho odtiaľ načíta ako plugin `workflow@skills-dir`. Nič iné sa globálne nemení.

**Linux**

```sh
mkdir -p ~/.claude/skills
git clone https://github.com/gavalierm/agentic-flow-public.git ~/.claude/skills/workflow
git -C ~/.claude/skills/workflow checkout "$(git -C ~/.claude/skills/workflow tag -l 'v*' --sort=-v:refname | head -1)"   # najnovšie vydanie (tag), nie branch
git -C ~/.claude/skills/workflow describe --tags            # vypíše nainštalované vydanie, napr. v0.9.14
cd ~/.claude/skills/workflow && npm test                    # voliteľné: testy workflow (bez závislostí)
```

**macOS**

```sh
mkdir -p ~/.claude/skills
git clone https://github.com/gavalierm/agentic-flow-public.git ~/.claude/skills/workflow
git -C ~/.claude/skills/workflow checkout "$(git -C ~/.claude/skills/workflow tag -l 'v*' --sort=-v:refname | head -1)"
git -C ~/.claude/skills/workflow describe --tags
```

**Windows (PowerShell)**

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
$wf = "$env:USERPROFILE\.claude\skills\workflow"
git clone https://github.com/gavalierm/agentic-flow-public.git $wf
git -C $wf checkout (git -C $wf tag -l 'v*' --sort=-v:refname | Select-Object -First 1)
git -C $wf describe --tags
```

Ďalšie vydania stroj dostane sám: štart session prepne inštaláciu vydania na najnovšie vydanie z origin v rámci tej istej hlavnej verzie (predvolené `"workflow_version": "latest"`, od v0.9.35; staršie vydanie bez pinu ostane na nainštalovanom tagu, vtedy raz `node ~/.claude/skills/workflow/bin/brain.mjs pin latest --all` z priečinka projektu). Nová hlavná verzia je upgrade, nie update (P-066): štart session ju iba ohlási (`new major version … exists`), prechod urobíš zámerne pinom `node ~/.claude/skills/workflow/bin/brain.mjs pin 1 --all` (najnovšia 1.x, potom update v rámci 1.x) alebo pinom tagu `v1.Y.Z`. Pevné vydanie je iba záloha, napr. keď je najnovšie vydanie chybné (pozri „Jeden brain na viacerých počítačoch“).

Overenie: v ľubovoľnom projekte spusti `claude` a napíš `/plugins`. V zozname má byť `workflow` (vypnutý). Plugin je vypnutý predvolene; zapína sa v projekte.

## Zapnutie v projekte

### Pojmy a rozloženie

| Pojem | Čo to je | Príklad |
|---|---|---|
| koreň | priečinok s poštou a projektmi; ľubovoľný, aj s medzerou v ceste | `~/agentic`, `D:\Claude projekty` |
| projekt (obal) | priečinok jedného projektu v koreni; drží repo(á) projektu a jeho brain | `<koreň>/pilot/` |
| repo projektu | git repo s kódom; jeho priečinok je projekt v T3 / Claude Code a jeho názov je **meno projektu v pošte** (adresa `<repo>/<téma>`, `--sender`) | `<koreň>/pilot/pilot-app/` |
| brain projektu | git repo s dátami workflow (pamäť, rozhodnutia, témy, skilly projektu); voliteľný (P-024) | `<koreň>/pilot/pilot-brain/` |
| persona | agent s menom; jeho repo `agent-<meno>` je zároveň brain | `agent-bob` |
| doména | priečinok persony so značkou `.agentic-domain`: hranica zápisu agentov (P-052), brain domény je brain persony | `~/agentic/Bob/` |

- Projekt s vlastným brainom bez `.agentic-domain` nie je doména: agent v ňom zapisuje do priečinka projektu, kópií jeho tém a do ciest v `domain.allow_outside` v `policy.json` brainu.
- Priečinok projektu `~/agentic/<Projekt>/` (repá a `<projekt>-brain`) je doména: `project.mjs create` a `connect` doň zapíšu `.agentic-domain` s brainom projektu, `restore` ju doplní staršiemu priečinku. Kódová téma potom pracuje vo worktree `<Projekt>/.worktrees/`, nie v klone `../<repo>-topics/` (D-0002).
- Pomenovanie: obal `<Meno>` (doména, prvé písmeno vždy veľké; skripty ho tak založia, staršiu doménu s malým písmenom použijú, nevytvoria druhú), repo `<meno>-<časť>` (`-app`, `-web`), brain `<meno>-brain`. Repo nepomenuj rovnako ako obal (`pilot/pilot` je nečitateľné). Názov priečinka repa je meno v pošte, takže neskoršie premenovanie znamená nový kľúč pošty (pozri „Premenovanie projektu“).
- Odporúčaný spôsob: povedz agentovi „založ projekt `<meno>`“ (skill `workflow:project`, skript `bin/project.mjs`). Sprievodca založí `<koreň>/<Meno>/<meno>-<časť>` a `<koreň>/<Meno>/<meno>-brain`, súkromné repá na GitHube operátora, nastavenia projektu, dôveru priečinka, projekt v T3 a v ňom uvítacie vlákno `vitaj` (na stroji bez CLI `t3` vypíše kroky pre nástroje T3 a hook Stop ich pripomína, kým nie sú hotové); koreň je uložený koreň stroja (`project.mjs root <dir>` ho uloží do `~/.config/agentic-flow/projects-root`; prvé výslovné `--root` ho uloží tiež), inak `~/agentic`; jednorazovo iný `--root <dir>`. Ten istý skript obnoví projekt na novom stroji (`restore`) a pripojí existujúce repá (`connect`). Ručný postup je nižšie.
- Persona: `persona-create.mjs <meno> [--root <dir>]` (predvolene doména `<koreň stroja>/<Meno>`, bez uloženého koreňa `~/agentic/<Meno>`).
- Presun domény pod koreň stroja: `domain-move.mjs <doména> --dry` (plán), potom bez `--dry` (potvrdí operátor): presun so symlinkom starej cesty, história a dôvera Claude Code, absolútne cesty v brainoch (logy a rozhodnutia ostanú), adaptér; projekty T3 presmeruje agent nástrojom `t3_project_update`. Po reštarte servera T3 `domain-move.mjs finish <stará cesta>`.
- Mapa ciest a verzia dát: cesty dát brainu aj repa projektu má workflow v jednej mape „logický názov → cesta“ v `scripts/layout.mjs` pre každú verziu dát (1, 2.0, 2.1; dáta 2.1 má mapu brainu a mapu repa projektu); žiadny iný modul ich nepíše literálom. Mapa sa vyberá podľa kľúča `data_layout` repa (nižšie).

### Dáta (verzie 1, 2.0 a 2.1)

Každý druh dát má jedno miesto (P-067). Pravidlá a skilly menujú miesta logicky; cesty pre verziu repa vypíše štart session v bloku „Dáta tohto repa“ (`scripts/boot.mjs`, `dataMapLines`). Nový brain má dáta 2.1 (`brain-init.mjs`, šablóna `templates/brain-3/`; `--layout 1|2.0` staršie šablóny).

Skript ani skill nemá pevnú cestu pracovných súborov (P-068): priečinok vlákna vypíše a vytvorí `node ~/.claude/skills/workflow/bin/work-dir.mjs` (dáta 2.1 `topics/<držaná téma alebo main>/tmp`, dáta 2.0 `temy/<…>/tmp`, dáta 1 `scratch/`; `--main` pre súbor, ktorý číta viac tém; projekt z `--project`, `WORKFLOW_PROJECT_DIR` alebo cwd, vlákno z `WORKFLOW_THREAD_ID` či `T3CODE_THREAD_ID`). `save.mjs skill` odmietne a `skill-check.mjs` nahlási `scratch/` či pracovné súbory konkrétnej témy v tele skillu alebo v jeho skripte; text skillu píše zástupný tvar `topics/<téma>/tmp/`.

| Logické miesto | Dáta 2.1 | Dáta 2.0 | Dáta 1 |
|---|---|---|---|
| zdroje (súbory zvonka, nemenia sa) | `zdroje/<téma>/` hlavného cieľového repa témy; zápis hneď `save.mjs source <súbor\|priečinok> --description "..." [--as <meno\|podcesta>] [--repo <repo>]` vo vlastnom klone workflow (priečinok jedným commitom, mená podľa pravidla mien s vypísaným mapovaním), popis, pôvod a dátum v `.brain/sources.json` repa | `zdroje/<téma>/` repa projektu | `materialy/<téma>/` repa projektu |
| práca témy (handover, výsledky práce) | `topics/<téma>/` brainu (`.tema.json`, `handover.md`, výsledky `save.mjs result <súbor>`, naviazané na zdroj v `tmp/` a obnovované na konci ťahu; ukázaný Artifact či náhľad a súbor citovaný v handoveri sa uložia sami, P-078); pri `done --topic` triáž presunie výstupy do `vystupy/<typ>/` a téma zanikne (bez archívu) | `temy/<téma>/` brainu; uzavretá téma ostáva na mieste, téma s iba handoverom v skrytom `.brain/archive/topics/<téma>/` (`done.mjs --archive-closed`) | `topics/<téma>/` brainu (`topic.json`, `holder.json`, `results.md`), uzavretá v `topics/archive/` |
| pracovné súbory (mimo gitu) | `topics/<téma>/tmp/` brainu, zaniknú s témou (`done --topic` pred tým uloží naviazané a citované súbory, P-078) | `temy/<téma>/tmp/` brainu | `scratch/` repa projektu |
| výstupy | `vystupy/<typ>/` cieľového repa (téma v hlavičke `topic:`), iba hotové diela tém, iba triážou pri `done --topic` | `vystupy/dokumenty/` brainu aj repa projektu | `docs/` |
| rozhodnutia (`save.mjs decision`) | `decisions/` brainu; rozhodnutie jedného repa (`--repo`) v `.brain/decisions/` repa: rozhodnutie je vedomosť, nie výstup | `vystupy/rozhodnutia/` brainu aj repa projektu | `decisions/` |
| fakt o subjekte (pamäť agenta) | `memory/` brainu (aj `rules/`, `skills/`, `exceptions/`, `logs/`, `policy.json` v koreni brainu) | `.brain/memory/` (aj `rules/`, `skills/` … v `.brain/`) | `memory/` |
| fakt o človeku | `osoby/<id>.md` repa operátora (`workflow:people`, `save.mjs person`) | to isté | to isté |
| INDEX.md | v koreni repa projektu aj brainu; generuje ho workflow pri každom zápise, ručne sa needituje; súbor ignore nasadenia v koreni (`.assetsignore`, `.vercelignore`, `.netlifyignore`, `.dockerignore`, `.gcloudignore` a i.) dostane v tom istom commite chýbajúce interné priečinky a `INDEX.md` (výstup to vypíše), aby ich nasadenie nezverejnilo | v koreni repa | nie je |
| vedomosti repa projektu | `.brain/` repa | `.brain/` repa | `agentic/` |

Verziu dát repa určuje kľúč `data_layout` (`"2.0"`, `"2.1"`; staršie čísla 2 a 3 znamenajú to isté): v `policy.json` v koreni brainu (dáta 2.1, rola brain), v `.brain/policy.json` repa (dáta 2.0 a repo projektu dát 2.1), inak `agentic/policy.json`; chýbajúci kľúč je verzia 1. Iná verzia, než workflow pozná, je chyba s výzvou aktualizovať workflow. Brain a repo projektu dát 2.1 majú rovnaký `data_layout`: keď jedno z nich má dáta 2.1 a druhé iný, štart session aj `save` odmietnu prácu s príkazom `git -C <staršie repo> pull`. Cieľové repá témy sú v `.tema.json` (`topic.mjs repos`), bez zoznamu platí `default_repo` politiky brainu domény; cieľová vetva repa je `target_branch` v jeho `.workflow.json` (predvolene `main`, `target_protected: true` = zlučuje iba človek, nekódový obsah ide do `topic/<téma>--obsah`).

Správanie v dátach 2.1: vstupy a fakty sa ukladajú hneď (zdroje, osoby, pamäť, rozhodnutia), výsledky práce žijú počas témy v `topics/<téma>/` a do `vystupy/<typ>/` sa dostanú jedine triážou pri `done --topic` (skill `workflow:done`; operátor sa pýta iba na nový typ a nejasné zaradenie); „ulož toto“ bez cieľa: agent navrhne cieľ a uloží po potvrdení.

Presun existujúceho repa: `node <plugin>/bin/migrate.mjs` z dát 1 do 2.0 (náhľad „odkiaľ → kam“, potom presun `git mv` a nastavenie verzie; položky mimo mapy triedi potvrdená triáž TSV `cesta, navrh, tema, dovod`), `migrate.mjs <repo> --to 2.1` z dát 2.0 do 2.1 (celá doména naraz: brain a každé repo domény, jeden commit v každom repe; `--check`, `--revert-list`). Bez argumentov (aj `--help`) vypíše použitie, formát TSV a povolené hodnoty; voľby opisuje hlavička `bin/migrate.mjs` a `bin/README.md`.

### Ručne

1. V koreni projektu vytvor `.claude/settings.json` (alebo doplň existujúci):

   ```json
   {
     "enabledPlugins": { "workflow@skills-dir": true },
     "autoMemoryEnabled": false
   }
   ```

2. Brain je voliteľný (P-024): projekt, ktorý spravuje persona, vlastný brain nemá (témy a pamäť sú v brain persony) a krok 2–3 vynechá. Vlastný brain iba na pokyn operátora: v koreni projektu vytvor `.workflow.json` s relatívnou cestou k brain (vždy s `/`, nikdy absolútna cesta):

   ```json
   { "brain": "../<nazov-brain>" }
   ```

   Ak brain na tomto stroji leží inde, zapíš cestu do `local/workflow.json` (rovnaký formát; `local/` je v `.gitignore`). Ten má prednosť.

3. Ak taký brain ešte neexistuje, založ ho: `node ~/.claude/skills/workflow/bin/brain-init.mjs ../<nazov-brain> --project . [--remote <adresa-repa-brain>]`. Existujúci klon brain aktivuj: `node ~/.claude/skills/workflow/bin/brain-init.mjs ../<nazov-brain> --attach --project .` (nastaví `core.hooksPath`, vytvorí `local/`).
4. Súbory commitni do projektu. Spusti `claude` v projekte; agent v ňom odpovedá; keď drží tému, prvá odpoveď začína riadkom `<projekt> / <téma>` (pozri „Prvé použitie“).

Oba súbory generuje adaptér: `node ~/.claude/skills/workflow/bin/adapter.mjs claude-code` (spusti v koreni projektu; cieľ je priečinok, v ktorom beží, alebo `--project`, nie projekt session (`CLAUDE_PROJECT_DIR`, `WORKFLOW_PROJECT_DIR`), takže persona ho môže spustiť v spravovanom projekte). Vytvorí `.claude/settings.json` (`enabledPlugins`, `permissions.ask`; vlastné pravidlá operátora v `permissions.allow` ponechá, flow-public#96, `autoMemoryEnabled: false`, `autoCompactWindow`), `.workflow.json` iba s `--brain ../<nazov-brain>` (bez neho projekt brain nemá), zapíše `.claude/skills/`, `local/` a `scratch/` do `.gitignore`, vytvorí `scratch/` (pracovné súbory agenta, P-052) a skopíruje skilly brain do `.claude/skills/`. Na stroji s budením pošty (`wake.mjs install`) zapíše do jeho `wake.json` úlohu `issue-watch` (kontrola sledovaných issue, jedna pre všetky projekty stroja; úlohu iného klonu, ktorého skript existuje, nechá tak; bez budenia nezapíše nič a vypíše riadok; keď je konfigurácia pošty súbor bez inštancie a dátového priečinka (budenie s `--config`), nezapíše nič a vypíše JSON úlohy pre jeho `wake.jobs`). Generované súbory neupravuj, ďalšie generovanie ich prepíše.

### Persona (jedno repo)

Persona je projekt, ktorého repo je zároveň brain (P-024): `.workflow.json` má `"brain": "."`. Persona nemá vlastné dáta projektu; dokumenty a výstupy idú do spravovaných projektov.

1. Nová persona: `node ~/.claude/skills/workflow/bin/persona-create.mjs <meno>` (krátke meno, napr. `bob`); skript sám odvodí repo `agent-<meno>`, overí, že neexistuje (ak existuje, skončí chybou, náhradné meno nepoužije), založí súkromné repo a brain v doméne `~/agentic/<Meno>/agent-<meno>` so značkou `.agentic-domain` (brain `agent-<meno>`). Nie ručné `brain-init` ani ručné založenie repa, lebo prefix `agent-` by sa dal obísť. Existujúce repo persony: `brain-init.mjs . --attach`.
2. V repe persony: `node ~/.claude/skills/workflow/bin/adapter.mjs claude-code --brain .`. Adaptér vygenerované súbory (`.workflow.json`, `.claude/settings.json`, `.gitignore`) sám commitne cez skript brain a pushne.
3. Agent v persone priamo zapisuje iba do pracovných súborov (dáta 1 `scratch/`, dáta 2.0 `temy/<téma>/tmp/`, dáta 2.1 `topics/<téma>/tmp/`) a `local/`; všetko ostatné ide cez `save`, `topic`, `done`. Worktree persony používa brain hlavného checkoutu.

### Doména (v3)

Doména je priečinok, v ktorom agenti smú zapisovať (P-052): persona a repá, ktoré spravuje, ležia spolu; názvy priečinkov sú názvy git repozitárov.

```
~/agentic/<Doména>/        prvé písmeno veľké (Bob, Kubo); repá v nej malými písmenami
  .agentic-domain          {"brain": "agent-<meno>"}  (relatívne ku koreňu domény)
  agent-<meno>/            brain persony (.workflow.json "brain": ".")
  <repo>/                  spravované repo; vedomosť repa v <repo>/agentic/ (HANDOVER.md, decisions/, runbooks/, memory/, skills/, rules/, policy.json)
  .worktrees/<repo>/<téma>/  kópie kódu kódových tém (git worktree, vetva topic/<téma>)
~/services/<repo>/         nainštalované vydanie (checkout tagu), z ktorého bežia služby; súbory sa tu nemenia, iba checkout tagu
```

Zápis mimo domény hook zamietne (nepýta sa). Výnimky má brain domény v `policy.json`: `{"domain": {"allow_outside": ["~/cesta", "/etc", "sudo"]}}` (`sudo` povolí príkaz sudo). Platí aj pre `~/services/<repo>` (nainštalované vydanie): inak sa mení iba inštaláciou tagu, ale záznam v `allow_outside` ho povolí. Značku `.agentic-domain` agent nezmení.

Vrstvy v doméne (D-0025). Politika: plugin, `policy.json` brainu domény, potom projektová vrstva (`policy.json` vlastného brainu projektu, ak to nie je brain domény, a `<repo>/agentic/policy.json`). Projektová vrstva iba sprísňuje: zoznamy zákazov a otázok (`harness.deny_*`, `denied_tools`, `ask_commands`, `immutable_principles`) dopĺňa, zoznamy povolení a výnimiek (`domain.allow_outside`, `ask_commands_except`, `logs.readonly_commands`, `subagent_stop_exempt_agent_types`) iba zužuje, limity (`limits.*`, prahy `destructive`) iba znižuje a `harness.native_memory` iba vypína; ostatné kľúče (modely, príkazy, `workflow_version`, `maintainer` …) ignoruje a štart session aj adaptér to vypíšu riadkom `policy: project layer ignored (only tightening): …`. Pravidlá: jadro workflow, výnimky (iba z brainu domény), `rules/` brainu domény, `rules/` brainu projektu, `<repo>/agentic/rules/*.md` (`save.mjs rule <meno> --repo [<repo>]`); výnimky v projektovej vrstve sa neuplatnia a vypíšu sa medzi odmietnutými. Skilly: plugin, brain domény, projektová vrstva; rovnaké meno v dvoch vrstvách je chyba. V persone sa vlastné skilly brainu nasadia ako `<persona>-<meno>` (napr. `alice-deploy`, s prepísaným `name:`, každou cestou do priečinka vlastného skillu, aj `$H/…`, `~/…` a relatívnou, cestou cez premennú `$<var>/<meno>/<súbor>` či `${<var>}/<meno>/<súbor>`, keď `<súbor>` je v skille, a zmienkami v kópii; brain drží mená bez prefixu; riadok crontabu so starou cestou a cestu cez premennú do priečinka bez prefixu, ktorý v cieli nie je, adaptér iba ohlási varovaním); skilly domény, rep a workflow prefix nedostanú (D-0065). Iný projekt na braine persony nechá menám skillov tvar bez prefixu, ale cestu `<repo persony>/.claude/skills/<meno>` v kópii prepíše na `<meno persony>-<meno>`, priečinok, ktorý persona nasadí. `.workflow.json` projektu v doméne má pole `domain` (cesta ku koreňu domény relatívne k repu, zapíše ho adaptér); keď nesedí s doménou nad projektom, adaptér skončí chybou s oboma cestami. Projekt mimo domény má jedinú vrstvu, svoj brain.

### Premenovanie projektu

1. Ukonči session projektu (Windows: ukonči aj nečinný `claude.exe`, ktorý T3 drží pre vlákno projektu, inak presun zlyhá).
2. Premenuj priečinok repa (aj repo na GitHube). Adaptér netreba spúšťať znova: cesta k brainu je relatívna.
3. Pošta: meno projektu je názov priečinka repa. `comms key add --sender <nové-meno>`, nový kľúč zapíš do `<brain>/local/comms.json`, starý `comms key remove --sender <staré-meno>`.
4. V T3 zmeň priečinok projektu (`workspaceRoot`) na novú cestu.

### Jeden brain na viacerých počítačoch

Každý počítač má vlastný klon brainu a stabilné meno stroja v `~/.config/agentic-flow/machine-id` (pri prvom behu z hostname, dá sa prepísať). Štart session stiahne brain z origin. Logy sa zapisujú do `logs/<stroj>/<dátum>.log` (iba pridávaním); spojený pohľad je v `local/logs/`. Pri synchronizácii sa `holder.json` vyrieši automaticky (platí origin a nový držiteľ sa overí), pri handoveri sa zachovajú obe verzie s poznámkou a `topic.json` sa zlúči po poliach. Pri ostatných súboroch skript vypíše príkaz `brain.mjs resolve <súbor> --keep local|remote`. Držiteľ témy je vlákno na konkrétnom stroji. Prechod na iný stroj: `topic.mjs handoff <téma> --task … --done … --next …`, potom na druhom stroji `topic.mjs claim <téma>`. Ak tému drží iný stroj bez aktivity dlhšie ako `topics.stale_machine_hours` (predvolene 12), claim ponúkne prevzatie po súhlase operátora. Predvolene (`policy.json` bez `workflow_version`, alebo `"latest"`) štart session prepne inštaláciu vydania na najnovšie vydanie z origin v tej istej hlavnej verzii: každý stroj dostane každé vydanie hlavnej verzie bez úpravy pinu, nikdy vývojovú vetvu (vývojový klon na vetve sa neprepína). Nová hlavná verzia je upgrade, nie update (P-066, D-0050): štart session a `check.mjs` ju iba ohlásia (`new major version vN… exists`, `upgrade available`), nikdy neprepnú. Zámerný upgrade je pin hlavnej verzie `{"workflow_version": "1"}` (najnovšia 1.x, ďalšie vydania 1.x dostane sám; 2.0.0 iba ohlási) alebo pin tagu novej hlavnej verzie. Pevné vydanie `{"workflow_version": "vX.Y.Z"}` (od v0.9.11) je záloha, napr. keď je najnovšie vydanie chybné: štart session prepne inštaláciu na tento tag a hlási zvlášť novšie vydanie tej istej hlavnej verzie (update, pin ho drží späť) a novú hlavnú verziu (upgrade); po oprave vráť `latest`. Inštalácia je jedna pre všetky projekty na stroji: pin maj vo všetkých brainoch na stroji rovnaký. Pin nastav príkazom z priečinka projektu (od v0.9.17): `node ~/.claude/skills/workflow/bin/brain.mjs pin <vX.Y.Z|N|latest> [--all]`. Zapíše `workflow_version` do `policy.json` (ostatné kľúče ostanú), commitne a pushne ako ostatné zápisy brainu; `--all` to isté urobí vo všetkých brainoch, v ktorých na tomto stroji bežala session (zoznam v `~/.config/agentic-flow/pin.json`). Ručná úprava `policy.json` a `git commit` nefunguje: pre-commit brainu ju odmietne (P-040) a necommitnutá zmena blokuje sťahovanie brainu z origin. Klon sa prepne pri ďalšom štarte session (alebo `/clear`). Ak sa líšia (od v0.9.14), inštaláciu prepne iba brain, ktorý ju nastavil naposledy, alebo brain, ktorému si pin práve zmenil; ostatné ju neprepnú späť a pri štarte nahlásia `workflow not switched … set the same workflow_version in every brain on this machine`.

### Cez agenta

Spusti `claude` v koreni projektu a povedz:

> Zapni v tomto projekte workflow. (Voliteľne: Brain je `../<nazov-brain>`; ak neexistuje, založ ho.)

Agent urobí iba toto: spustí adaptér (`node ~/.claude/skills/workflow/bin/adapter.mjs claude-code`, s brain `--brain ../<nazov-brain>`), ktorý vytvorí `.claude/settings.json` (a s brain `.workflow.json`); bez pokynu brain nezakladá ani nenavrhuje; s brain, ktorý na ceste chýba, navrhne `brain-init` a počká na tvoj súhlas; nakoniec oznámi, ktoré súbory vznikli. Commit urobí až na tvoj pokyn („commitni to“). Ak Claude Code zobrazí otázku o dôvere priečinku alebo hookom, potvrď ju; bez dôvery niektoré nastavenia projektu neplatia.

Potom ukonči session a spusti `claude` znova, aby sa plugin načítal.

## Prvé použitie

- **Spustenie vlákna:** v T3 dostane vlákno ID automaticky. V termináli spusti `node ~/.claude/skills/workflow/bin/thread.mjs` (vygeneruje `WORKFLOW_THREAD_ID` a spustí `claude`; ďalšie argumenty za `--` idú harnessu, napr. `-- --resume`). Bez stabilného ID vlákno nemôže zabrať tému.
- **Pri štarte** začne prvá odpoveď vlákna, ktoré drží tému, riadkom `<projekt> / <téma>`, vlákna bez témy riadkom `<projekt> / bez témy`. **Výber témy (P-012):** vlákno bez témy sa pri prvom kroku práce (zápis, skript skillu, Artifact, pracovník) spýta dialógom, či pokračovať v existujúcej téme (odporučí tú, s ktorou sa zadanie zhoduje), založiť novú, alebo ostať bez témy (nič sa neuloží); zadanie mimo držanej témy ponúkne prepnúť na inú tému, novú tému alebo pokračovať. Kým neodpovieš, krok neprejde. Agent navyše pri každom tvojom prompte dostane stavový riadok `thread <id> | topic <id> (<state>, mode <mode>) | mail: n` (pri zastavenom budení stroja navyše `| wake: off`), aj po `/clear` a `--resume`; ten vidí iba agent. Záverečná odpoveď ťahu je protokol (P-061): výsledok, bloky **Otázky na operátora:** a **Úlohy pre operátora:**, **Handover:** a **Stav:** hotovo | otázka | čakám (na …).
- **Hlavné vlákno persony** drží trvalú tému `main` (`topic main`, raz v hlavnom vlákne); jeho prvá odpoveď začína `<persona> / main` a stavový riadok počíta poštu `@<persona>/main`. **Téma pre nové vlákno:** nové vlákno vzniká iba na tvoju žiadosť alebo na žiadosť supervisora: `topic create <id> --subject "…" --class <trieda> --task "…" --new-thread --requested-by operator|supervisor`, nové vlákno tému drží od prvého ťahu. **Prekryv:** `topic create` vypíše otvorené témy toho istého repa či projektu s prekrývajúcim sa rozsahom (`overlap: …`), nič neodmietne; stav tém, zaseknutia, nečinné zámky a témy na uzavretie číta prehľad supervisora (`overview.mjs`).
- **Téma:** „založ tému `<id>` s predmetom …“ → agent spustí `workflow:topic` (`create`, pri kóde vznikne worktree `<doména>/.worktrees/<repo>/<id>/`, mimo domény klon `../<projekt>-topics/<id>/`). Dve vlákna nemôžu držať tú istú tému; prevzatie len na tvoj pokyn.
- **Ukladanie:** „ulož …“, „zapamätaj si …“, „volám sa …“ → `workflow:save`. Ručný zápis do brain agent nemôže (hook + pre-commit).
- **Ukončenie:** „hotovo“, „done“, „uzavri to“ → `workflow:done --topic --knowledge "<čo je zapísané cez save | nic nové>"`: v dátach 2.1 triáž výsledkov podľa typu do `vystupy/<typ>/`, zlúčenie vetvy témy do cieľovej vetvy každého cieľového repa (chránená vetva: žiadosť o zlúčenie v Úlohách pre operátora), téma zanikne; manažér ho spustí aj sám po splnení Zadania. Zrušenie témy bez triáže a zlúčenia iba na tvoj pokyn (`done --topic --cancel`). `done` bez `--topic` uzavrie jednotku práce a téma pokračuje.
- **Ručný zápis operátora do brain** (napr. skill v `skills/operator/`): commitni s `git commit --no-verify`; pre-commit odmieta commity mimo skriptov zámerne.

## Pošta (voliteľné)

Správy medzi témami a agentmi (`blocker`, `steer`, `assist`; `info` je zrušená, 2026-11-02) nosí samostatná služba z repa `agentic-comms`. Bez nej workflow beží bez zmeny a stavový riadok ukazuje `mail: 0`.

Zapnutie v projekte (všetky kroky mimo bežiacej session):

1. Odporúčané rozloženie: pošta je spoločná pre všetky projekty a leží **mimo nich**, každý projekt má vlastný priečinok s repom projektu a jeho brain:

   ```
   <koreň>/
     comms/                  pošta (git clone https://github.com/gavalierm/agentic-comms-public.git comms)
     projekt-a/
       <repo-projektu>/
       <brain-projektu>/
     projekt-b/
       ...
   ```

   Workflow hľadá klienta predvolene na `../../comms/bin/comms.mjs` a potom na staršom mieste `../agentic-comms/bin/comms.mjs` (relatívne k projektu); pri tomto rozložení nič ďalšie netreba nastavovať. Iné umiestnenie: do `.workflow.json` (alebo do necommitovaného `local/workflow.json`, ak platí iba pre tento stroj) doplň

   ```json
   { "brain": "../<nazov-brain>", "comms": { "client": "<klon agentic-comms>/bin/comms.mjs", "instance": "pilot" } }
   ```

   (`instance` je voliteľná; `"comms": false` poštu vypne; `"project"` prepíše názov projektu v adrese správ, predvolene názov priečinka projektu).
   Stroj, ktorý používa server pošty na inom stroji (tunel), nastav raz pre všetky brainy: `node <plugin>/bin/project.mjs mail-machine --url https://<server>/ --instance-id <id> --key-file <súbor s kľúčom od správcu>` zapíše `~/.config/agentic-flow/comms.json` (práva 600) a overí `health`; brain bez vlastného `local/comms.json` ho použije. Odpovede tomuto stroju prinesie budenie čítajúce ten server: `node <klon agentic-comms>/bin/wake.mjs install --config ~/.config/agentic-flow/comms.json`.
2. Založ inštanciu pošty a kľúč tohto projektu: `node ../agentic-comms/bin/comms.mjs init --instance pilot --sender <nazov-projektu>` (druhý a ďalší projekt: `comms key add --sender ...`). Kľúč a identifikátor inštancie zapíš do **`<brain>/local/comms.json`** (necommitovaný súbor; `local/` je v `.gitignore` brain):

   ```json
   { "instance": "pilot", "key": "<kľúč>", "instance_id": "<id z init>" }
   ```

3. Spusti session. Službu pošty netreba spúšťať ručne: klient ju pri prvom volaní spustí na pozadí (lokálny socket, bez portu). Stavový riadok ukáže `mail: <n>` pre držanú tému a odpovede tomuto vláknu; pri `n > 0` pribudne jeden riadok `mail: n waiting: <id> <kategória>` bez textu; telo správy číta hlavný agent cez `comms receive --id <id>`. Over: „aký je stav pošty?“ → agent spustí `comms.mjs status`.

Čo sa deje potom: `topic create`/`claim` zaregistruje tému v pošte (idempotentne, s držiteľom), takže iní agenti jej vedia písať na adresu `<projekt>/<téma>` (téma iného brainu: `<brain>[@<stroj>]:<projekt>/<téma>`, pošta modelu 3). Správy pre nezaregistrovanú tému pošta pozdrží a vytvorí oznam operátorovi (`comms notices`, stránka pošty). Pri výpadku pošty hook čaká najviac 2 s, stavový riadok oznámi „comms unavailable“ raz za minútu, odchádzajúce správy čakajú v `<brain>/local/outbox/` a odošlú sa pri ďalšom úspešnom volaní. Ťah spustený správou („you have mail in topic X“) nesmie prevziať tému, uzavrieť ju ani meniť pravidlá; skripty to odmietnu. Založiť novú tému (`topic create`) a dať vlákno téme bez držiteľa (`topic thread`) smie.

Hlásenie chyby workflow (`error.mjs report`) ide poštou raz priamo do vlákna T3 správcu workflow (`comms send --maintainer`). ID vlákna nastavuje operátor na serveri pošty v `instance.json`: `"maintainer": { "thread": "<ID vlákna T3>", "machine": "<stroj>" }` (číta sa pri každom odoslaní, bez reštartu). Keď server vlákno správcu nemá, alebo vlákno neexistuje (zvonček `undelivered` / `no reply` → `error.mjs report --from <id>`), skript založí issue vo verejnom repe workflow (`policy.maintainer.repo`, mení `brain.mjs maintainer --repo <url>|none`). Až keď nejde ani issue, zapíše koncept do priečinka témy a úlohu pre operátora (spec 7). Počas prestavby zmrazenie (`brain.mjs freeze on --until <verzia> --reason "<dôvod>" [--allow <téma>,..]`, `freeze off`; P-074): `topic create` kódovej témy v repe workflow či pošty mimo povolených tém odmietne; hlásenia chodia ďalej.

## Codex (voliteľné)

Ten istý workflow (pravidlá, skilly, hooky, brain) beží aj v Codex CLI. Codex nemá pluginy, preto adaptér vygeneruje do projektu natívne súbory Codexu z toho istého zdroja. Codex na stroji nie je podmienkou pre Claude Code a naopak.

**Inštalácia**

1. Nainštaluj Codex CLI podľa návodu OpenAI a prihlás sa (`codex` v termináli).
2. Workflow musí byť naklonovaný ako pri Claude Code (`~/.claude/skills/workflow`, pozri „Inštalácia“); Codex používa ten istý klon a ten istý brain.

**Zapnutie v projekte** (v koreni projektu, mimo bežiacej session)

```sh
node ~/.claude/skills/workflow/bin/adapter.mjs codex
```

Vznikne:

- `.codex/config.toml` a `AGENTS.md` (commitni ich; `AGENTS.md` nesie pravidlá workflow v bloku `<!-- workflow:begin -->` … `<!-- workflow:end -->`, tvoj ostatný text v `AGENTS.md` ostáva),
- `.workflow.json`, ak chýbal (commitni),
- `.codex/hooks.json` a `.agents/skills/` (lokálne; adaptér ich zapíše do `.gitignore`, lebo obsahujú cestu ku klonu workflow na tomto stroji; `.agents/skills/` sa prepíše pri každom štarte).

Ak už `.codex/config.toml` v projekte máš a nevytvoril ho adaptér, adaptér ho odmietne prepísať: presuň jeho nastavenia do `~/.codex/config.toml` a súbor zmaž.

**Prvý štart a potvrdenia**

1. Spusti Codex v koreni projektu: `node ~/.claude/skills/workflow/bin/thread.mjs --harness codex` (dodá stabilné ID vlákna; v T3 ho dodáva T3 cez `T3CODE_THREAD_ID`).
2. Codex sa opýta, či projektu dôveruješ. **Potvrď dôveru**; bez nej Codex projektový `.codex/config.toml` ani hooky nenačíta.
3. Napíš `/hooks`. Zobrazí sa zoznam hookov workflow (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop); **potvrď ich (trust)**. Codex si pamätá odtlačok každého hooku, takže po aktualizácii workflow (`git pull`) ich treba potvrdiť znova; pri štarte na to upozorní.
4. Po potvrdení ukonči a spusti Codex znova. Pri štarte sa má objaviť stavový riadok `thread <id> | topic … | mail: …` a riadok `workflow <sha>`. Ak hook hlási `AGENTS.md stale`, spusti adaptér znova a commitni rozdiel.

**Rozdiely oproti Claude Code**

- Pravidlá sú v `AGENTS.md` (statické, generované), nie v hooku; po zmene pravidiel alebo výnimiek v brain treba adaptér spustiť znova.
- Codex nevie „opýtaj sa pred krokom“: krok, ktorý by v Claude Code vyžiadal potvrdenie (prepis necommitnutého súboru, `git reset --hard` …), hook v Codexe odmietne a povie, čo urobiť (commitnúť cieľ, alebo krok vykoná operátor).
- Správa `assist` alebo `blocker` bez odpovede: po uplynutí lehoty (TTL) budenie zobudí odosielateľa (P-042, P-043).
- Skilly sa volajú menom bez predpony (`save`, `topic`, …), nie `workflow:save`.

**Vypnutie v projekte:** zmaž `.codex/config.toml`, `.codex/hooks.json`, `.agents/skills/` a blok workflow v `AGENTS.md`.

## Aktualizácia

Stabilná verzia je vždy tag vydania (`vX.Y.Z`), nikdy branch:

```sh
git -C ~/.claude/skills/workflow fetch --tags
git -C ~/.claude/skills/workflow checkout v<nová-verzia>
```

Windows: to isté s `-C "$env:USERPROFILE\.claude\skills\workflow"`.

Robí sa mimo bežiacej session; zmeny platia od ďalšieho štartu. Všetky projekty na stroji, ktoré používajú stabilnú verziu, majú tú istú verziu (zámer). Nainštalované vydanie: `git -C ~/.claude/skills/workflow describe --tags` (agent ho dostane pri štarte ako riadok `workflow <sha>`). Ak `checkout` hlási lokálne zmeny, v klone niekto zapisoval; klon má byť čistý (pozri Riešenie problémov).

## Vývojová verzia (kanál dev)

Vývoj workflow beží na tom istom stroji a pod tým istým používateľom ako produkcia, bez vplyvu na ňu (P-051):

- **Repo:** `main` = stabilný stav, vydania sú tagy `vX.Y.Z`. Vývoj ide do branchu `dev`. Vydanie: merge `dev` do `main`, tag, push.
- **Línia 0.9** (P-069, D-0068): iné stroje inštalujú z verejnej kópie na 0.9.x, kým 1.x čaká na súhlas operátora (D-0050). Oprava, ktorá ich blokuje, ide do vetvy `maint/0.9` (z v0.9.99) a vydá sa ako `v0.9.N` (N číselne od 101; aktualizácia 0.9.x ju berie ako novšiu), tag na `maint/0.9`, bez merge do `main` a bez prepnutia stable; relevantná oprava ide aj do `dev`. `tools/publish/publish.mjs push` dá vydanie na verejný `main`, kým ten nesie 0.9, inak na verejnú vetvu `maint/0.9`; verejný `main` sa tým nikdy neposunie na inú hlavnú verziu.
- **Stabilný kanál** (produkcia): klon `~/.claude/skills/workflow` na tagu, plugin `workflow@skills-dir`.
- **Vývojový kanál** (test): druhý klon na branchi `dev` **mimo** `~/.claude/skills/`, napr. `<koreň-pilota>/workflow`. Načíta ho premenná prostredia `CLAUDE_CODE_PLUGIN_DIRS=<absolútna cesta ku klonu>` ako plugin `workflow@inline`. Premenná musí byť v prostredí procesu, ktorý spúšťa sedenia (napr. služba T3; v termináli `export`). V `env` súboru `.claude/settings.json` nefunguje.
- **Voľba v projekte:** `node <klon>/bin/adapter.mjs claude-code --channel dev` (alebo `--channel stable`). Kanál `stable` zapíše `workflow@skills-dir: true`, `workflow@inline: false`; kanál `dev` naopak. Pregenerovanie bez `--channel` kanál ponechá. Projekt bez zápisu `workflow@inline: true` vývojový klon nenačíta, aj keď je premenná nastavená.
- **Nasadenie zmeny na test:** push do `dev`, potom `git -C <koreň-pilota>/workflow pull --ff-only`. Produkcia sa nezmení.
- Zápisy do brain kontrolujú git hooky tej verzie, ktorá zápis robí (skripty posielajú `WORKFLOW_PLUGIN_ROOT`).
- **Testy:** `npm test`, iba kritické testy, celá sada najviac 60 s. Každý testovací súbor má hlavičku `// keep: core` (jadro: ochrana dát, zvonček, jeden zapisovač, tajomstvá, vydanie, `done`, štart, `save`, pošta; beží vždy), `// keep: guarded` (trvalý test zriedka menenej časti, napr. `migrate`; beží iba pri zmene kódu, ktorý chráni) alebo `// ttl: YYYY-MM-DD` (test opravy, 30 dní); súbor bez nej `npm test` zastaví. `node tests/ttl.mjs expire` zmaže vypršané testy v samostatnom commite a vydanie ho volá pred testami. Celá sada beží cez slot (`scripts/test-slot.mjs`, D-0069): na stroji najviac 2 celé behy testov naraz (spoločne s `agentic-comms`, priečinok `~/.local/state/agentic/test-slots`), ďalší `npm test` vypíše `waiting for a test slot` a počká; jeden súbor `node --test <súbor>` limit nemá. `npm test -- --since <ref>` (D-0085) spustí jadro a iba dočasné testy, ktorých chránený kód (súbory commitu, ktorý test pridal, a priame importy) alebo samotný test sa od `<ref>` zmenil; zmena `tests/helpers.mjs`, `package.json`, `tests/ttl.mjs` či `scripts/test-slot.mjs` spustí všetko; vypíše `tests: core N + changed M of K temporary (since <ref>)`. Celú sadu spusti raz na konci zmeny, počas práce iba testy, ktorých sa zmena týka. Podrobne `tests/README.md`.

## Vypnutie

- **V jednom projekte:** v `.claude/settings.json` nastav `"workflow@skills-dir": false` alebo riadok odstráň.
- **Na jedno sedenie:** `claude --settings '{"enabledPlugins":{"workflow@skills-dir":false}}'`, alebo rovnaký zápis v `.claude/settings.local.json`.

## Odinštalovanie

```sh
rm -rf ~/.claude/skills/workflow
```

Windows: `Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\skills\workflow"`.

Projekty, ktoré majú workflow zapnutý, pri štarte iba oznámia chýbajúci plugin; ich dáta ani brain sa nemenia. Brain je samostatné repo, odinštalovanie workflow ho nemaže.

## Riešenie bežných problémov

| Prejav | Príčina | Riešenie |
|---|---|---|
| `/plugins` plugin `workflow` nezobrazuje | klon je v inom priečinku alebo chýba `.claude-plugin/plugin.json` | over cestu `~/.claude/skills/workflow/.claude-plugin/plugin.json` |
| plugin je v zozname, ale agent nedostáva stavový riadok `thread <id> | …` a prvá odpoveď vlákna s témou nezačína `<projekt> / <téma>` | projekt nemá `enabledPlugins`, alebo si session nespustil v koreni projektu, alebo nie je potvrdená dôvera priečinku | over `.claude/settings.json`, spusti `claude` v koreni, potvrď dôveru |
| `node: command not found` / `'node' is not recognized` | Node nie je nainštalovaný alebo nie je v PATH | nainštaluj Node 22+, reštartuj terminál, `node --version` |
| pri štarte „brain not found“ | zlá cesta v `.workflow.json`, alebo brain na tomto stroji leží inde | oprav cestu (relatívna, s `/`), alebo doplň `local/workflow.json` |
| `git pull` hlási lokálne zmeny v klone | do klonu niekto zapisoval (nemá) | `git -C ~/.claude/skills/workflow status`; zmeny zahoď iba vedome (`git checkout -- .`), potom `pull` |
| Windows: `git pull` mení konce riadkov | chýba `core.autocrlf=false` | repo má `.gitattributes` s `eol=lf`; nastav `git config --global core.autocrlf false` |
| agent zapísal do brain priamo a commit zlyhal | pre-commit hook brain odmietol commit bez značky skriptu (zámer) | zápis do brain ide iba cez skripty workflow (`save`, `topic`, `done`) |
| stavový riadok ukazuje `thread - (no stable id …)` | session bez stabilného ID vlákna (IDE, desktop) | spusti harness cez `node ~/.claude/skills/workflow/bin/thread.mjs`, alebo pracuj bez zabratia témy |
| `topic claim` hlási `held by thread …` | tému drží iné vlákno (aj zaniknuté) | pokračuj v pôvodnom vlákne, alebo na tvoj výslovný pokyn `claim <id> --force --operator-approved` |
| pri štarte `(local changes in plugin clone, P-014)` | v klone workflow niekto zapisoval | `git -C ~/.claude/skills/workflow status`, zmeny zahoď vedome |
| brain pre-commit: `workflow plugin not found` | klon workflow nie je v `~/.claude/skills/workflow` | naklonuj ho tam, alebo nastav `WORKFLOW_PLUGIN_ROOT` |
| stavový riadok `mail: 0 (comms client not found at …)` | `comms.client` v `.workflow.json` ukazuje na neexistujúci súbor | oprav cestu (relatívne k projektu), alebo pole odstráň (predvolené `../../comms/bin/comms.mjs`, potom `../agentic-comms/bin/comms.mjs`) |
| stavový riadok `mail: ? (comms unavailable)` alebo `(neplatný kľúč)` | služba pošty nebeží a nedá sa spustiť, alebo chýba `<brain>/local/comms.json` s kľúčom | `node ../agentic-comms/bin/comms.mjs health --instance <meno>`; doplň kľúč podľa „Pošta“ |
| stavový riadok končí `| wake: off` | budenie na tomto stroji už bežalo a teraz nebeží (pošta comms od v0.4.6): zvončeky neprídu, vlákna sa samy nezobudia | `node ../agentic-comms/bin/wake.mjs status --instance <meno>`; trvalý beh `node ../agentic-comms/bin/wake.mjs install --instance <meno>` (Linux, macOS, Windows) |
| zvonček `no reply <id>` / `undelivered <id>` k hláseniu chyby (`error.mjs report`) | vlákno správcu hlásenie v lehote neprevzalo alebo neexistuje | `error.mjs report --from <id>`: hlásenie sa poštou neopakuje, skript ho založí ako issue vo verejnom repe workflow; až keď issue nejde, dá položku pre Úlohy pre operátora |
| stavový riadok končí `| issues: N answer(s) not rung (error.mjs watch)` | správca odpovedal na sledované issue, ale zvonček nemal kam ísť (téma hlásiteľa uzavretá, projekt bez persony) | `node ~/.claude/skills/workflow/bin/error.mjs watch` vypíše odkazy; issue prečítaj na GitHube, potom `error.mjs confirm|reopen <url> --text "..."` |
| `comms send` hlási `held, operator notice` | cieľová téma nie je v pošte zaregistrovaná | adresát ju zaberie (`topic claim`), alebo operátor rozhodne v oznamoch (`redirect`/`deliver`) |
| Codex: pri štarte chýba stavový riadok | projekt nie je dôveryhodný alebo hooky nie sú potvrdené | potvrď dôveru projektu, `/hooks` → trust, reštart Codexu |
| Codex: `AGENTS.md stale` | pravidlá alebo výnimky v brain sa zmenili od posledného generovania | `node ~/.claude/skills/workflow/bin/adapter.mjs codex`, commitni `AGENTS.md` |
| Codex: adaptér hlási `config.toml … not generated by workflow` | v projekte je ručne písaný `.codex/config.toml` | presuň jeho nastavenia do `~/.codex/config.toml`, súbor zmaž, spusti adaptér znova |
