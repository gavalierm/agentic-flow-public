# Brain

Dáta workflow pre jednu doménu (P-024), dáta 2.1 (`"data_layout": "2.1"` v `policy.json`, flow v2, špecifikácia kap. 4). Názvy priečinkov sú anglické. Zapisujú sem iba skripty workflow (`save`, `topic`, `done`, hooky logov) cez `brain.mjs`; ručný zápis odmietne pre-commit hook (P-040). Cesty logických miest vypíše štart session v bloku „Dáta tohto repa“.

- `topics/<topic>/`: celá téma: `.tema.json` (trieda, režim, cieľové repá, zámok v kľúči `holder`, stav), `handover.md` a výsledky práce témy (v gite, v jazyku repa projektu); `topics/<topic>/tmp/` sú pracovné súbory mimo gitu, lokálne a pominuteľné. `topics/<x>` píše iba jej manažér (zámok), ostatné priečinky sú spoločné.
- `memory/`: fakty o neľudských subjektoch (1 súbor = 1 subjekt); fakty o ľuďoch patria do `osoby/` repa operátora.
- `decisions/`: voľby (jedna vec = jeden súbor s frontmatter `key`, P-031).
- `rules/`, `skills/operator/`, `skills/agentic/`: poučenia domény (skilly agenta s `origin: error | routine`, P-032).
- `exceptions/`: výnimky z princípov po vrstvách (P-035). `logs/`: surové pozorovania (P-030).
- `policy.json`: doplnky politiky domény (P-017), verzia tvaru dát a predvolené repo projektu domény (`default_repo`).
- `INDEX.md`: riadok na každý súbor v `topics/` a `decisions/`; generuje ho workflow pri každom zápise, ručne sa needituje.
- `local/` (necommitované): indexy, `threads/`, `log-buffer/`, `outbox/`, `tajomstva/` (heslá a tokeny ako `<služba>.env`, P-018).

Hotové výstupy a zdroje v braine nie sú: idú do cieľového repa témy, do `vystupy/<typ>/` a `zdroje/<téma>/` repa projektu, ktoré nesie rovnaký `data_layout` v `.brain/policy.json`. Štart session odmietne prácu v repe, ktorého dáta nesedia s brainom (urob pull).

Aktivácia na novom stroji: `git config core.hooksPath .githooks` (robí `brain-init.mjs --attach`). Ručný commit operátora: `git commit --no-verify` (vedome).
