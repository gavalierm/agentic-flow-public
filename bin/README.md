# bin/

Vstupné body skriptov, volané ako `node <plugin>/bin/<name>.mjs` v koreni projektu (alebo s `--project <dir>`). Bez závislostí (P-034). Logika je v `scripts/`.

| Skript | Princíp | Úloha |
|---|---|---|
| `brain.mjs write|remove|sync|resolve|pin|status` | P-040, P-037, P-025 | jediný zapisovač do brain: zápis, commit so značkou `[brain-script]`, push, kontrola nesúhlasu, retry na `index.lock`, kontrola držiteľa; `pin <vX.Y.Z or latest> [--all]` nastaví `workflow_version` vo všetkých brainoch stroja (flow-public#7) |
| `brain-init.mjs <path> [--attach [--adopt]] [--remote] [--project]` | P-024, P-018, P-040 | založenie brain zo `templates/brain/` alebo aktivácia klonu: `core.hooksPath`, `local/`; `--adopt` nahradí staré git hooky šablónou workflow, doplní `.gitignore` a commitne to |
| `project.mjs probe|restore|connect|create|inventory|tidy|wizard` | P-024, P-018, P-002, P-056 | skript skillu `project`: `wizard start|end` otvorí a zavrie okno, v ktorom sa sprievodca pýta dialógom; nájde projekt na disku a v repozitároch operátora, obnoví ho, pripojí repozitáre do priečinka projektu (`~/agentic/<doména>/<repo>` a spoločný `<meno>-brain`; doména je názov priečinka, ktorý zvolí operátor, aj s medzerami: `--domain`) (premenovanie brainu, prevzatie starého brainu na jeho vetve), založí nový, inventúra starého repa, dohodnuté odstránenia, presuny a prepisy starých záznamov na mieste v brain |
| `persona-create.mjs <meno> [--root] [--token-file]` | P-024 | nová persona: repo vždy `agent-<meno>` (skript ho odvodí, pri existujúcom repe skončí chybou), súkromné repo + brain; `brain-init.mjs --persona` vynúti prefix v adrese aj adresári |
| `brain-precommit.mjs pre-commit|commit-msg` | P-040 | kontrolná logika git hookov brain (volajú ju shimy z `templates/brain/.githooks/`) |
| `rules.mjs [--check]` | P-035, P-022 | zostavenie pravidiel z vrstiev, výpis výnimiek, kontrola limitov |
| `index.mjs` | P-039, P-010 | generovanie indexov do `<brain>/local/index/`, kontrola limitov |
| `find.mjs <query> | --relates-to | --similar` | P-031 | deterministické vyhľadanie kľúčov, aliasov a väzieb |
| `topic.mjs create|claim|release|list|status|copy` | P-036, P-037, P-045 | témy, držiteľ, kópia kódu |
| `thread.mjs [--id] [-- <args>]` | P-038 | vygeneruje `WORKFLOW_THREAD_ID` a spustí harness |
| `adapter.mjs claude-code | codex | --version` | P-017, P-015 | Claude Code: `.claude/settings.json`, `.workflow.json`, `.gitignore`, kópia skillov brain; Codex: `.codex/config.toml`, `AGENTS.md`, lokálne `.codex/hooks.json` a `.agents/skills/` (pozri `adapters/codex/`) |
| `save.mjs memory|decision|rule|exception|skill|handover` | P-013, P-007 | skript skillu `save` |
| `done.mjs [--topic] --verified` | P-029, P-005, P-006, P-036 | skript skillu `done` |
| `error.mjs list|check|resolve` | P-003, P-028 | skript skillu `error` |
| `delegate.mjs prepare|check` | P-027, P-028 | skript skillu `delegate` |
| `t3-workarounds.mjs list|check [--t3-home] [--t3] [--thread] [--no-upstream] [--json]` | PLAN 35 | register T3 workaroundov (`docs/t3-workarounds.json`) a ich kontrola po každom upgrade T3; `FAIL` → exit 1 |
| `consolidate.mjs report` | P-010 | skript skillu `consolidate` |
| `skill-check.mjs [<skill>]`, `skill-check.mjs diff <skill> --file <nový>` | P-003, P-032 | skript skillu `skill-check`; tú istú kontrolu spúšťa `save skill` |
| `log.mjs flush|failures|names` | P-030 | logy pozorovaní (volá ich hook Stop) |
| `comms.mjs status|count|list|receive|ack|send|notices|decide|register` | P-041, P-042, P-044, P-047 | skript skillu `comms`: obal nad klientom `agentic-comms` s konfiguráciou projektu; telo správy vypisuje ako dáta |
| `services.mjs install <repo> [<tag>]` | D-0003 | nainštalované vydanie: `~/services/<repo>/` = checkout tagu repa z domény (klon z origin, ak chýba; lokálne zmeny odmietne); jediná cesta zmeny `~/services` (priamy zápis hook zamietne) |
| `check.mjs --loaded <sha>` | P-020, P-021 | skript skillu `check`: porovná verziu zo štartu session s nainštalovanou; novšia → vypíše aktuálne pravidlá, rovnaká → hlásenie správcovi (`maintainer/workflow-dev`) |
