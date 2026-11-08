---
name: delegate
description: Použi, keď treba prieskum, zber alebo prípravu dát (čítanie viacerých súborov, grep, logy, dokumentácia) alebo ohraničenú úlohu, ktorej výsledkom má byť záver, nie obsah. Spúšťa pracovníka workflow:worker.
argument-hint: "prepare --task \"...\" | check --file <result>"
---

# delegate – pracovník bez workflow (P-027, P-028, P-025)

1. `node ${CLAUDE_PLUGIN_ROOT}/bin/delegate.mjs prepare --task "<zadanie vlastnými slovami>"` vráti blok zadania s pravidlami výsledku, cestou pre pracovné súbory (`<projekt>/scratch/`) a pribalenými skillmi brain, ktorých trigger zodpovedá zadaniu. Výstup použi ako prompt; zadanie bez tejto cesty hook zamietne. Nie zadanie písané ručne, lebo pracovník bez cesty píše do /tmp a každý zápis tam čakal na potvrdenie operátora (2026-11-02, 13×); zápis do systémového /tmp hook zamietne s cestou do scratch/.
2. Spusti subagenta `workflow:worker` (Agent tool) s týmto promptom. Model nezadávaj, pracovník beží na lacnom modeli z politiky (P-053). Vyšší model (`model: sonnet`) zadaj iba pri náročnej syntéze, návrhu alebo implementácii a dôvod napíš do zadania. Pracovník nedostáva pravidlá, indexy ani témy; kód smie meniť iba v kópii témy, ak ju v zadaní uvedieš. Zadanie s veľa položkami na čítanie (desiatky vlákien, súborov, stránok) rozdeľ na viac pracovníkov po najviac ~50 položiek a nástroje T3 v ňom nech volá sériovo.
nie stovky čítaní v jednom pracovníkovi, lebo 259 `t3_thread_read` prekročilo jeho kontext a dokončil 1 brief z 259; paralelné volania v pracovníkovi zlyhali „adapter has no active turn“ (agentic-flow-public#14).
3. Výsledok (limit 2 000 znakov) over: `delegate.mjs check --file <výsledok>` alebo kontrolou časti „Failures“. Hook SubagentStop pracovníka `workflow:worker` bez „Failures“ vráti.
4. Neprázdne „Failures“ spracuj cez `workflow:error`; zlyhania sú aj v `error.mjs list`.

Sám čítaj iba to, čo potrebuješ na rozhodnutie alebo overenie (P-019, P-020).
