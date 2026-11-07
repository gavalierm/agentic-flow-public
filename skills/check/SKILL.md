---
name: check
description: Použi, keď máš podozrenie, že niečo vo workflow nefunguje, ako by malo (skript, hook, pravidlo alebo skill sa správa inak, než opisuje), alebo keď treba workflow aktualizovať. Aktualizuje inštaláciu na najnovšie vydanie a porovná verzie; ak novšia nie je, problém nahlásiš.
argument-hint: "--loaded <sha>"
---

# check – aktualizácia workflow alebo hlásenie problému

1. Verziu načítanú v tejto session máš v štartovacom kontexte v časti `## Workflow` (`workflow <sha>`).
2. `node ${CLAUDE_PLUGIN_ROOT}/bin/check.mjs --loaded <sha>`. Skript najprv prepne inštaláciu vydania na najnovší tag (`updated: … -> …`); klon na vetve alebo so zmenami neprepína (`not updated: …`, povedz to operátorovi).
3. `newer workflow installed`: vypísané pravidlá platia namiesto pravidiel zo štartu session. Skilly a hooky sa zmenia až v novej session alebo po `/clear`: povedz to operátorovi jedným riadkom. Problém skús znova; ak trvá, pokračuj krokom 4.
4. `up to date`: problém nahlás správcovi workflow `error.mjs report --title … --text …` (pošta, inak issue, skill `workflow:error` krok 5) (téma vývoja workflow; ak ju držíš sám, problém rieš v nej) (skill `workflow:comms`): čo si čakal, čo sa stalo, príkaz a jeho výstup. Workflow sám neopravuj a plugin ručne neprepínaj.
