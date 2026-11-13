---
name: shell
description: Použi, keď píšeš jednoriadkový príkaz shellu s awk, sed, presmerovaním alebo `cd`, najmä keď zapisuje do súborov.
---

# shell – pasce jednoriadkových príkazov (P-003)

- awk: porovnanie v `print` daj do zátvoriek: `print $1, ($2 > 0)`.
  nie `print $1, $2>0`, lebo `>` v `print` je presmerovanie: vznikne súbor `0` (alebo `1`) v aktuálnom priečinku. To isté `|` (rúra do príkazu) a `>>`.
- sed `-i` a presmerovanie do súboru v inom repe: cieľ píš absolútnou cestou.
  nie `cd <repo> && sed -i … <relatívna cesta>`, lebo povolenia harness vyhodnocuje voči priečinku session, nie voči `cd`, a zápis zamietne alebo trafí iný súbor.
- Cestu k súboru (patch, vstup, výstup) v príkaze píš absolútne, aj keď priečinok zmenil `cd` v predchádzajúcom volaní.
  nie relatívna cesta po `cd` z predchádzajúceho volania, lebo `cd` v hlavnej session pretrváva do ďalšieho volania a `git apply <relatívny patch>` skončil „can't open patch“ (report-36a6774e).
- grep cez viac súborov, z ktorého tvrdíš, čo je v ktorom súbore: `grep -H` (alebo jeden grep na súbor). Hook pri `grep -h` cez viac súborov, glob alebo `-r` pridá upozornenie (nie pri `-o` ani keď výstup ide do `sort`, `uniq`, `wc`, `cut`, `awk`).
  nie `grep -h` a priradenie riadkov súborom podľa predpokladaného poradia, lebo vznikli dva neexistujúce rozpory medzi dennými reportmi (2026-11-07).
- Súbor, ktorý takto vznikol omylom (napr. `0`), zmaž a oznám s príkazom, ktorý ho vytvoril (P-018).
