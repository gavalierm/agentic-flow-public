# Brain

Dáta workflow pre jeden projekt (P-024). Zapisujú sem iba skripty workflow (`save`, `topic`, `done`, hooky logov) cez `brain.mjs`; ručný zápis odmietne pre-commit hook (P-040).

- `memory/`, `decisions/`, `rules/`: jedna vec = jeden súbor s frontmatter `key` (P-031, P-039).
- `skills/operator/` (skilly operátora), `skills/agentic/` (skilly agenta, `origin: error | routine`, P-032).
- `topics/<id>/`: `topic.json`, `holder.json`, `handover.md`; uzavreté témy v `topics/archive/` (P-036).
- `exceptions/`: výnimky z princípov po vrstvách (P-035). `logs/`: surové pozorovania (P-030).
- `local/` (necommitované): indexy, `exceptions.md`, `threads/`, `log-buffer/`, `outbox/`, `tajomstva/` (heslá a tokeny ako `<služba>.env`, P-018).
- `policy.json`: projektové doplnky politiky (P-017).
- Persona (P-024): repo persony je zároveň brain (`"brain": "."`); navyše obsahuje iba `.workflow.json`, `.gitignore`, `.claude/settings.json` (commituje adaptér) `docs/` (trvalé dokumenty persony, zapisuje agent priamo, commit `save.mjs docs`) a necommitované `scratch/`, `local/`.

Aktivácia na novom stroji: `git config core.hooksPath .githooks` (robí `brain-init.mjs --attach`). Ručný commit operátora: `git commit --no-verify` (vedome).
