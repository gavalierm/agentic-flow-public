---
name: find
description: Použi pred každým hľadaním v brain – či subjekt, rozhodnutie, pravidlo alebo skill existuje – namiesto čítania súborov. Vráti iba cesty a jeden riadok popisu.
argument-hint: "<query> | --relates-to <path>"
---

# find – deterministické vyhľadanie v brain (P-031)

- `node ${CLAUDE_PLUGIN_ROOT}/bin/find.mjs <query>` – zhoda na kľúč, alias alebo normalizovaný názov v pamäti, rozhodnutiach, pravidlách a skilloch všetkých úložísk stroja: najprv brain session, potom brain domény, potom ostatné (brainy projektov a domén, `<repo>/agentic/`). Výstup: `cesta: popis`, nikdy obsah; záznam iného operátora (autor commitu, ktorý pridal jeho súbor) končí `[by <meno>]`, záznam mimo brainu session `[store <úložisko>]`. `D-0001` nájde to číslo vo všetkých úložiskách, `<úložisko>/D-0001` iba v menovanom. Bez presnej zhody nasleduje slovná zhoda (všetky slová dopytu v kľúči, mene, aliasoch alebo popise) s riadkom `no exact match: …; word matches:`. Bez zhody v kľúči, mene, aliasoch a popise prečíta telá a vypíše iba cesty záznamov, v ktorých tele sú všetky slová dopytu (`no match in key, name, aliases or description: …; in the body of:`); tak nájdeš tému či voľné slovo, ktoré nie je väzbou (D-0029). `no match` znamená, že záznam neexistuje ani podľa slov v tele. Nie hľadanie iba podľa celého mena, lebo skill pre tú istú prácu pod iným menom by ostal neodhalený a vznikla by duplicita.
- `find.mjs --relates-to <kľúč|D-NNNN|P-NNN|cesta>` – záznamy (najmä rozhodnutia), ktoré sa viažu na danú vec. Pred zmenou veci s platným rozhodnutím si rozhodnutie prečítaj (P-008).
- `find.mjs --similar <type-name>` – podobné kľúče rovnakého typu (používa `save`).

Detail záznamu čítaj až po zhode a iba ten jeden súbor (P-001).
