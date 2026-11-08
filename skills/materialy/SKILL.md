---
name: materialy
description: Použi, keď ukladáš čokoľvek, čo prišlo zvonka (od operátora, stiahnuté, prílohy), alebo výsledok práce témy v repe projektu, a keď súbor presahuje 50 MB.
argument-hint: "record <súbor> --from <odkiaľ> | check"
---

# materialy – materiály témy v repe projektu (P-062)

Priečinok `materialy/<téma>/` je v gite repa projektu; `<téma>` je meno témy workflow. Skript: `node ${CLAUDE_PLUGIN_ROOT}/bin/materialy.mjs`.

1. **Kedy:** hneď, ako niečo príde zvonka (zadanie a súbory od operátora, stiahnuté súbory a archívy, prílohy) a keď vznikne výsledok práce. Nie až na konci.
2. **Kde:** priečinok `materialy/<téma>/` založ sám pri prvom zápise; repo, ktoré materiály nepotrebuje, ho nemá. Štruktúra vnútri je voľná (podpriečinky podľa druhu). Medzivýsledky ostávajú v `scratch/` (P-052).
3. **Spoločné:** čo používa viac tém, je v repe raz (napr. `materialy/ux-audit/`); iná téma ho odkáže cestou (v handoveri a vo svojom výsledku), nekopíruje.
4. **Nad 50 MB** (`policy.limits.materialy_max_mb`) súbor do gitu nepatrí. Nechaj ho tam, odkiaľ prišiel (priečinok klienta, príloha, adresa na stiahnutie); stiahnutý leží v `scratch/` (nie v `local/`, ten patrí operátorovi, P-018). V gite nechaj záznam: `materialy.mjs record <súbor> --from <odkiaľ> [--topic <téma>]` zapíše `materialy/<téma>/<meno>.zaznam.json` (odkiaľ, dátum, veľkosť, sha256, kde súbor leží). Hook zamietne Write nad limit; `materialy.mjs check` pred commitom vypíše súbory v `materialy/` nad limitom (kód 1), ktoré do gitu nepatria.
5. **Katalóg:** ak existuje `materialy/`, katalóg ho berie automaticky ako zdroj `materialy` (režim rw; vypne `catalog.materialy: false` v `local/workflow.json`). Hľadaj cez `catalog.mjs find`, nie `ls`/`grep` po priečinku.
