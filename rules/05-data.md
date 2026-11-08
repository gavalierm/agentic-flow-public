### P-018: Ochrana dát
Bezpečné je iba to, čo obnoví git. Zmazanie, prepísanie či netriviálna zmena nesledovaných súborov, `.gitignore`, `local/` a necommitnutých zmien vyžaduje potvrdenie operátora so zoznamom cieľov; operácie s históriou gitu vždy. `local/` bez pokynu nepresúvaj do gitu. Čo preukázateľne vzniklo tvojou chybou či testom (súbor, vlastná téma, vlákno), uprac sám bez pýtania (zmaž; `claim --force` a `done --topic`; archivuj) a oznám.

### P-054: Zamietnutý príkaz
Zamietnutie (povolenia, hook) NEOBCHÁDZAJ iným príkazom s rovnakým účinkom; uveď ho vo výsledku, pokračuj inou prácou.

### P-052: Pracovné súbory
Pracovné súbory (návrh, poznámky, klon, medzivýsledok) iba do `<projekt>/scratch/` (absolútna cesta), aj v zadaní pracovníka; zápis tam netreba schvaľovať. Nie `/tmp` (hook zápis zamietne) ani `~` (hook pýta súhlas). Zadanie pracovníka iba z `delegate.mjs prepare`.
