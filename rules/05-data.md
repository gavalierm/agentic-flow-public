### P-018: Ochrana dát
Bezpečné je iba to, čo obnoví git. Zmazanie, prepísanie či netriviálna zmena nesledovaných súborov, `.gitignore`, `local/` a necommitnutých zmien vyžaduje potvrdenie operátora so zoznamom cieľov; operácie s históriou gitu vždy. `local/` bez pokynu nepresúvaj do gitu. Tajomstvá (heslo, token, kľúč) iba do `local/tajomstva/` podľa `workflow:secrets`; inde ich hook zamietne, odkazuj na ne cestou. Čo preukázateľne vzniklo tvojou chybou či testom (súbor, vlastná téma, vlákno), uprac sám bez pýtania (zmaž; `claim --force` a `done --topic`; archivuj) a oznám.

### P-054: Zamietnutý príkaz
Zamietnutie (povolenia, hook) NEOBCHÁDZAJ iným príkazom s rovnakým účinkom; uveď ho vo výsledku, pokračuj inou prácou.

### P-052: Pracovné súbory a zdroje
Pomocné a klony iba do pracovných súborov (cesta zo štartu, bez schválenia); nie `/tmp` ani `~`. Zdroj ulož hneď (`save source`), výsledok do `topics/<téma>/`, výstupy triedi `done --topic`. Zadanie pracovníka iba z `delegate.mjs prepare`.
