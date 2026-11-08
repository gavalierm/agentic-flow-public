---
name: skill-check
description: Použi, keď operátor povie „skontroluj skilly“, keď skill zlyhal alebo naviedol zle, keď consolidate hlási zdravie skillov, alebo pred úpravou ručne písaného skillu. Kontroluje platnosť, cesty, odkazy, antivzory a nezávislosť od stroja v skilloch projektu.
argument-hint: "[<skill>]"
---

# skill-check – zdravie skillov projektu (P-003, P-032, P-052)

Rozsah: iba skilly tohto projektu (brain `skills/operator`, `skills/agentic` a ručné skilly v `<projekt>/.claude/skills`, ktoré nie sú v brain).

1. `node ${CLAUDE_PLUGIN_ROOT}/bin/skill-check.mjs [<skill>]` vypíše nálezy po skilloch: `error` (skill je pokazený: zlý formát, neexistujúca cesta, skript, `workflow:<x>` alebo `P-XXX`, stará cesta domény, zrušená úroveň pošty, doslovné `\n`) a `warn` (heuristika: antivzor, cesta iného stroja, rast doplnení, skript bez volania). `error` oprav vždy; `warn` posúď (riadok, ktorý antivzor iba menuje ako zákaz, je v poriadku).
2. Posúď sám aj to, čo skript nevie: spúšťač (popis) menuje situáciu presne a nechytá iné; doplnenia neodporujú telu; kroky sedia s platnými pravidlami a skillmi workflow; opakovaná sekvencia príkazov patrí do skriptu skillu (P-030).
3. Oprava podľa vlastníka:
   - `skills/agentic`: oprav hneď cez `workflow:save` (`save skill <meno> --replace --content "..."` alebo `--sed`); doplnenia zlúč do tela bez straty významu.
   - `skills/operator`: kozmetika a refaktor (preformulovanie, zlúčenie doplnení, oprava písmena domény v ceste) bez zmeny významu ulož rovnako; `save` ju porovná (`skill-check.mjs diff <meno> --file <nový SKILL.md>`: príkazy, cesty, odkazy, riadky „nie …“, čísla, popis) a zmenu významu odmietne. Zmenu významu ukáž operátorovi (čo, prečo), spýtaj sa dialógom `AskUserQuestion` a po jeho „áno“ ulož s `--approved "<jeho slová>"`.
   - Ručný skill mimo brain: navrhni operátorovi presun do `skills/operator/<meno>` (inak ho nevidí `find`, consolidate ani iný stroj).
4. `save skill` spúšťa tú istú kontrolu: skill s `error` neuloží.
5. Výsledok oznám po skilloch: opravené, navrhnuté operátorovi, ponechané `warn` s dôvodom.
