---
name: snapshot
description: Použi, keď operátor chce uložiť stav práce témy alebo vlákna, aby sa pokračovalo v čerstvej session (/clear): „sprav si snapshot (témy, vlákna)“, „ulož stav, dám clear“. Nie snapshot predmetu práce (web, konfigurácia, databáza): to je záloha alebo snímka v téme.
argument-hint: "[<téma>]"
---

# snapshot – stav témy pre čerstvú session (P-026, P-011, P-078)

Skript: `node ${CLAUDE_PLUGIN_ROOT}/bin/topic.mjs snapshot [<téma>]` (iba držiteľ témy).

Téma ostáva otvorená a tvoja: nič sa neuzatvára ani nezlučuje (to je `done`). Po `/clear` je kontext prázdny; nová session dostane iba to, čo je v braine: handover, vedomosť a uložené výsledky.

1. Vedomosť: pokyny operátora, rozhodnutia a overené fakty z tejto session, ktoré ešte nie sú v braine, zapíš teraz podľa otázok A a B (skill `workflow:save`). Po `/clear` sa stratia.
2. Výsledky: súbor z pracovných súborov, ktorý nová session potrebuje, ulož (`save.mjs result <súbor>`, zvonka `save.mjs source`); publikovanú stránku najprv doplň o aktuálny stav (skill `workflow:proposal`, Report výsledku).
3. Handover: `save.mjs handover <téma>` so všetkými šiestimi sekciami tak, aby z neho pokračoval niekto bez kontextu: Zadanie doslovne aj s trvalými pokynmi operátora, Hotové s faktami, ktoré to overujú, presný Ďalší krok (príkaz, súbor, miesto), súbory s cestami (nie priečinky pracovných súborov), otvorené otázky a úlohy.
4. `topic.mjs snapshot`: odmietne handover uložený pred týmto ťahom; uloží naviazané a citované pracovné súbory, vypíše neuložené a označí vlákno, aby koniec ťahu nespustil pokračovanie. Štart po `/clear` vloží handover do kontextu.
5. Odpoveď: 1–2 riadky, čo je uložené, a že operátor môže dať `/clear`; ťah ukonči `**Stav:** čakám (na /clear operátora)`.

nie `done` ako uloženie stavu, lebo `done --topic` tému ukončí a pracovné súbory zaniknú; operátor chcel tému iba „refreshnúť bez straty rozpracovanej práce“ (operátor 2026-11-18).
nie tento skill pri „sprav snapshot webu, konfigurácie, databázy“, lebo to je snímka predmetu práce (záloha, export) v téme, nie stav vlákna (operátor 2026-11-18).
