---
name: check
description: Použi, keď máš podozrenie, že niečo vo workflow nefunguje, ako by malo (skript, hook, pravidlo alebo skill sa správa inak, než opisuje), alebo keď treba workflow aktualizovať. Aktualizuje inštaláciu na najnovšie vydanie a porovná verzie; ak novšia nie je, problém nahlásiš.
argument-hint: "--loaded <sha>"
---

# check – aktualizácia workflow alebo hlásenie problému

1. Verziu načítanú v tejto session máš v štartovacom kontexte v časti `## Workflow` (`workflow <sha>`).
2. `node ${CLAUDE_PLUGIN_ROOT}/bin/check.mjs --loaded <sha>`. Skript najprv prepne inštaláciu vydania na najnovší tag tej istej hlavnej verzie (update, `updated: … -> …`; 0.9.x ostane na 0.9.x, 1.x na 1.x); klon na vetve alebo so zmenami neprepína (`not updated: …`, povedz to operátorovi).
3. `newer workflow installed`: vypísané pravidlá platia namiesto pravidiel zo štartu session. Skilly a hooky sa zmenia až v novej session alebo po `/clear`: povedz to operátorovi jedným riadkom. Problém skús znova; ak trvá, pokračuj krokom 5.
4. `held back` / `pinned`: brain je pripnutý na staršie vydanie (politika `workflow_version`), novšie v tej istej hlavnej verzii existuje. Nehovor „aktuálne“: operátorovi povedz pripnutú a najnovšiu verziu a že pripnutie zmení `brain.mjs pin latest` (každé ďalšie vydanie tej istej hlavnej verzie) alebo `brain.mjs pin <verzia>`. Zmenu pripnutia urobíš iba na jeho pokyn. Problém nahlás až vtedy, keď trvá aj na najnovšom vydaní.
   `upgrade available`: existuje nová hlavná verzia (upgrade, nie update, P-066); skript ju nikdy neprepne sám. Operátorovi to povedz raz; upgrade je iba zámerný, na jeho pokyn: `brain.mjs pin <N> --all` (najnovšia N.x, ďalej sa aktualizuje v rámci N) alebo `brain.mjs pin vN.Y.Z`. Problém nahlás aj bez upgradu, ak trvá na najnovšom vydaní svojej hlavnej verzie.
5. `up to date`: problém nahlás správcovi workflow `error.mjs report --title … --text …` (pošta, inak issue, skill `workflow:error` krok 5) (téma vývoja workflow; ak ju držíš sám, problém rieš v nej) (skill `workflow:comms`): čo si čakal, čo sa stalo, príkaz a jeho výstup. Workflow sám neopravuj a plugin ručne neprepínaj.
