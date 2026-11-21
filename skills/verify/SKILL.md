---
name: verify
description: Použi, keď tvrdíš, čo nástroj, služba alebo API vie (vlastnosť, limit, verzia), že niečo nie je (účet, prístup, súbor), alebo keď sa rozhodnutie či zápis do externej služby opiera o fakt sveta (sviatok, zákon, cena), o údaj, ktorý ponúkol nástroj, či o meranie z jednej snímky (pozícia, návštevnosť).
---

# verify – tvrdenia iba overené (P-019, P-003)

1. Schopnosť nástroja: zisti nainštalovanú alebo cieľovú verziu (`<nástroj> --version`, balíček, obraz) a schopnosť over v oficiálnej dokumentácii alebo changelogu tej verzie (WebSearch, potom WebFetch na dokumentáciu alebo repo), prípadne pokusom na tomto stroji.
2. Fakt sveta (sviatok, zákon, lehota, cena, otváracie hodiny): údaj, ktorý ponúkne nástroj (návrh editora, predvyplnenie, zoznam sviatkov, automatické doplnenie), je tvrdenie tretej strany, nie pozorovanie faktu. Over ho v aktuálnom autoritatívnom zdroji (zákon v platnom znení, úradný register, stránka vydavateľa) a zapamätaj si zdroj a jeho dátum.
3. Záporné tvrdenie (nie je účet s prístupom, súbor, nástroj, nastavenie): tvrď ho až po vyskúšaní všetkých kandidátov (všetky prihlásené účty, profily, priečinky); inak povedz, koľko z koľkých si vyskúšal a ktoré ostali. Náhradné riešenie mimo zadania (iné zariadenie, prehliadač iného počítača, iný účet) navrhni a urob až po súhlase operátora (P-002).
4. Meranie premenlivej veličiny (pozícia vo vyhľadávaní, cena, návštevnosť, dostupnosť): jedna snímka (živý SERP, jeden dopyt API, jedna návšteva stránky) závisí od času, miesta a personalizácie, je to vzorka, nie overený stav. Overené je iba z vlastných agregovaných dát za obdobie (Search Console, analytika, účet služby); bez nich ho podaj ako snímku s dátumom, zdrojom a obmedzením „jedna vzorka“.
5. Operátorovi uveď zdroj a istotu (overené / pravdepodobné / neviem); čo sa overiť nedalo, povedz ako neoverené. Zápis do externej služby alebo účtu (nastavenia, profil, hodiny) podľa faktu sveta: zdroj, jeho dátum a istotu daj do otázky na súhlas; neoverený údaj nezapisuj ako fakt, rozhodne operátor.
nie tvrdenie o schopnostiach z pamäte, lebo pamäť zaostáva za verziami: agent zavrhol monitorovací nástroj „treba agenta na zariadení“, hoci jeho verzia už mala sieťové monitory ICMP/TCP/HTTP/DNS na ľubovoľný cieľ (2026-11-03).
nie údaj z ponuky nástroja ako overený fakt, lebo agent zapísal do firemného profilu zatvorený deň podľa sviatku, ktorý ponúkol editor, hoci ten deň už podľa zmeny zákona nebol dňom pracovného pokoja, a operátor musel zápis zrušiť (flow-public#39, 2026-11-12).
nie „žiadny účet nemá prístup“ po skúške časti účtov, lebo agent vyskúšal tri zo štyroch prihlásených účtov, štvrtý s prístupom vynechal a prepol na prehliadač iného počítača (flow-public#40, 2026-11-12).
nie pozícia z jednej snímky SERP ako overená, lebo agent podal pozície webu z jedného živého SERP cez SEO API ako overené a Search Console za 12 mesiacov ich pri troch dopytoch vyvrátila (report-4a4caced, 2026-11-13).
