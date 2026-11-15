# Brain

Dáta workflow pre jeden projekt (P-024), tvar dát 2 (`"data_layout": 2` v `.brain/policy.json`). Každý druh dát má jedno miesto (P-067): viditeľné sú iba `zdroje/`, `temy/`, `vystupy/` a `INDEX.md`, všetko ostatné je v `.brain/`. Zapisujú sem iba skripty workflow (`save`, `topic`, `done`, `materialy`, hooky logov) cez `brain.mjs`; ručný zápis odmietne pre-commit hook (P-040). Cesty logických miest vypíše štart session v bloku „Tvar dát tohto repa“.

- `zdroje/<téma>/`: súbory zvonka (od operátora či zákazníka, stiahnuté, prílohy); nemenia sa, témy na ne iba odkazujú. Zdroj témy s projektom patrí do `zdroje/` repa projektu, tu iba zdroj témy bez projektu (persona, brain = projekt). Zdroj sa ukladá `materialy.mjs add <súbor> --description "..."`; popis, pôvod a dátum zdroja sú v `.brain/sources.json`.
- `temy/<id>/`: celá téma, aj téma projektu (D-0056; repo projektu nemá `temy/`): `.tema.json` (téma a jej držiteľ v kľúči `holder`), `handover.md`, súbory práce (analýzy, porovnania; výsledok práce `materialy.mjs add <súbor> --result`), závery pracovníkov v `zavery/`; `temy/<id>/tmp/` sú pracovné súbory mimo gitu, zmaže ich `done --topic`. Do `done` sa v téme nič nemaže ani netriedi; pri `done --topic` témy zadanej operátorom triáž s operátorom. Uzavretá téma ostáva v `temy/<id>/` so `state: "closed"` (P-036).
- `vystupy/rozhodnutia/`, `vystupy/dokumenty/`: čo z práce platí (rozhodnutia; trvalé dokumenty, zapisuje agent priamo, commit `save.mjs docs`), s odkazom na pôvod v téme alebo v zdrojoch. Hotový výsledok témy s projektom presunie triáž pri `done --topic` do `vystupy/dokumenty/` repa projektu (najprv commit tam, potom zmazanie z `temy/` tu); tu ostávajú dokumenty témy bez projektu.
- `INDEX.md`: riadok na každý súbor v `zdroje/`, `temy/` a `vystupy/` (cesta, popis, pôvod, téma, dátum; súbory uzavretej témy označené). Generuje ho workflow pri každom zápise; ručne sa needituje.
- `.brain/memory/` (pamäť agenta: fakty o ľuďoch, prostredí, nástrojoch, službách, projektoch), `.brain/rules/`: jedna vec = jeden súbor s frontmatter `key` (P-031, P-039); rozhodnutia vo `vystupy/rozhodnutia/` rovnako.
- `.brain/skills/operator/` (skilly operátora), `.brain/skills/agentic/` (skilly agenta, `origin: error | routine`, P-032).
- `.brain/exceptions/`: výnimky z princípov po vrstvách (P-035). `.brain/logs/`: surové pozorovania (P-030).
- `local/` (necommitované): indexy, `exceptions.md`, `threads/`, `log-buffer/`, `outbox/`.
- `.brain/policy.json`: projektové doplnky politiky (P-017) a verzia tvaru dát.
- Persona (P-024): repo persony je zároveň brain (`"brain": "."`); navyše obsahuje iba `.workflow.json`, `.gitignore`, `.claude/settings.json` (commituje adaptér) a necommitované `temy/*/tmp/`, `local/`.

Brain vo verzii 1 (`templates/brain/`) presunie do tohto tvaru `node <plugin>/bin/migrate.mjs` (najprv náhľad, potom presun); workflow počas prechodu číta oba tvary.

Aktivácia na novom stroji: `git config core.hooksPath .githooks` (robí `brain-init.mjs --attach`). Ručný commit operátora: `git commit --no-verify` (vedome).
