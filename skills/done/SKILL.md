---
name: done
description: Použi, keď operátor povie „done“, „hotovo“, „uzavri to“ (celá téma, --topic), alebo keď sám uzatváraš jednotku práce a téma pokračuje (bez --topic).
argument-hint: "[--topic] --verified \"<pozorovanie>\" [--procedures a,b] [--derivations k1,k2]"
---

# done – uzavretie jednotky práce alebo témy (P-029, P-005, P-006, P-011, P-020, P-036)

Skript: `node ${CLAUDE_PLUGIN_ROOT}/bin/done.mjs` (iba držiteľ témy).

Pokyn operátora „done“, „hotovo“, „uzavri to“ (aj `/workflow:done`) uzatvára **celú tému** (`--topic`), nie iba jednotku práce. Bez `--topic` uzatváraš iba ty sám jednotku práce, po ktorej téma pokračuje. Výnimka: téma `main` a vlákno bez témy (jednotka práce).
nie „tému neuzatváram, lebo ste o to nepožiadali“ po pokyne „done“, lebo operátor tým myslel celú tému (operátor 2026-11-03).

## Jednotka práce (sám, téma pokračuje)
1. Over výsledok jedným pozorovaním (spusti, pozri, porovnaj so zadaním). Bez toho skript odmietne; výsledok zapíš do `--verified "<čo si videl>"`.
2. `done.mjs --list` vypíše existujúce názvy v `procedures.log` a `derivations.log`. Použi existujúci názov, ak zodpovedá.
3. Postupy s viac ako 3 krokmi bez skillu (`find`) uveď v `--procedures <action>-<subject>-<qualifier>,...` (anglicky, bez hodnôt inštancie). Odvodenia z viacerých zdrojov uveď v `--derivations <kľúč>,...`.
4. Skript zapíše logy a handover nastaví na „voľná“; téma ostáva tvoja. Kódovú tému najprv zlúči do hlavnej vetvy projektu a kópiu nechá (D-0011); neuložené zmeny v kópii alebo v hlavnom checkoute odmietne, kým nezapíše nič: overený kód commitni v kópii. Vypíše: postup s 3 výskytmi → skill vytvor sám (`workflow:save`, bez súhlasu operátora). Odmietnutie ulož ako rozhodnutie „skill pre <postup> zamietnutý“ s `--relates-to P-005` (názov postupu v nadpise). Odvodenie s 2 výskytmi → ulož záver cez `save memory ... --origin derived --sources ...`.
5. Riadok „scratch: n file(s) … only in scratch/“: `scratch/` nie je v gite. Podklady zvonku a výsledky práce z neho presuň hneď do `materialy/<téma>/` (skill `workflow:materialy`), postup do skillu; medzivýsledky nechaj (P-062). Aj pred `done --topic` pozri `scratch/`, skript riadok vypíše až po archivácii.
6. Riadok „mail: n waiting (free point)“: odložené správy spracuj ešte pred odpoveďou operátorovi (skill `workflow:comms`, voľný bod).
7. Téma pokračuje: ďalšiu jednotku práce začni hneď v tomto vlákne, nečakaj na operátora (P-026). Drobná pripomienka k práci témy (oprava, úprava webu) je ďalšia jednotka v tej istej téme, nie nová téma (D-0011). Novú session navrhni až po `done --topic`. Vlákno bez témy ukončí jednotku tiež (`done --verified`, bez handoveru); vlákno bez témy a bez práce v kontexte (napr. po `/clear`) zavrie `done` bez parametrov, bez otázky operátorovi. V T3 potom archivuj vlákno; tému (ani `main`) nezaberaj iba kvôli `done`.
nie otázka operátorovi „môžem zlúčiť?“ po overenej jednotke, lebo ju zlúči `done` sám: 5 takých otázok, vždy zvolená odporúčaná možnosť, 5 887 s čakania (audit 2026-11-11); operátora sa pýtaš iba pred nasadením do produkcie (D-0011).

## Celá téma: `done.mjs --topic --verified "..."`
Pred tým presuň trvalé poznatky z handoveru podľa stromu P-007 cez `workflow:save`. Skript pri kódovej téme: v kópii zlúči najnovšiu hlavnú vetvu projektu (konflikty rieš v kópii a spusti znova), zlúči `topic/<id>` do hlavnej vetvy projektu, zmaže kópiu (worktree `git worktree remove` a vetvu); potom presunie `topics/<id>/` do `topics/archive/` a tému uzavrie v pošte (nové správy odmietne, čakajúce vráti odosielateľom). V ťahu spustenom správou skript odmietne (P-047), okrem ťahu, v ktorom operátor odpovedal v dialógu (`AskUserQuestion`, D-0011). V T3 skript vypíše riadok „thread: … settle this thread“: ako posledný krok ťahu (po odpovediach a oznámení operátorovi) označ vlastné vlákno ako vybavené nástrojom `t3_thread_organize` (action `settle`, bez threadId; uplatní sa po skončení ťahu). Vlákno, ktoré drží `main`, ostáva otvorené (skript to povie).
nie action `archive` na vlastné vlákno, lebo T3 ukončí bežiaci ťah chybou „provider event stream closed“ (flow-public#6, overené na Windowse aj Linuxe).
