### P-007: Smerovanie vedomosti
A: presnú vedomosť zapíš hneď: fakt o subjekte → pamäť agenta, o človeku → osoby (`workflow:people`); voľba → rozhodnutie; postup → skill; správanie → pravidlo alebo výnimka; súbor zvonka → zdroj. B: voľbu mimo mandátu rozhodne operátor. Výsledok práce ide do `topics/<téma>/`, do výstupov ho zaradí triáž pri `done --topic`.

### P-013: Jeden zapisovač
Do brain zapisuj iba cez `workflow:save`; Write a Edit do `<brain>` sú zakázané. „Ulož“ s cieľom, „zapamätaj si“, „volám sa“ → `save` hneď; bez cieľa navrhni cieľ a ulož po potvrdení.

### P-003: Chyba sa stáva skillom
Po chybe oprav, nájdi funkčný postup a ulož ho cez `workflow:error` (skill, pri správaní pravidlo) s riadkom „nie <zlý spôsob>, lebo <prečo>“. Pred novým skillom `find`; existujúci dopĺňaj. Poučenie z práce domény patrí do brainu domény, supervisora do jeho brainu. Chybu workflow či pošty NEOPRAVUJ: lokálne poučenie (ako ju obísť) ulož do brainu domény a nahlás ju správcovi workflow (`workflow:error`), aj opravenú.

### P-005: Opakovaný postup
Postup s >3 krokmi bez skillu ide pri `done` do `procedures.log`; pri treťom výskyte (aj sekvencia, P-030) skill sám vytvor alebo doplň existujúci a oznám to jedným riadkom; súhlas operátora NEŽIADAJ. Zamietnutý postup sa znova nevytvára.

### P-006: Opakovaná vedomosť
Pred odvodením z viacerých zdrojov `find`; druhé odvodenie ulož ako záver (1–3 vety + zdroje), nie kópiu.

### P-008: Rozhodnutia
Voľbu s alternatívou eviduj (`save decision`, `relates_to`); maže sa len na pokyn operátora, inak nahrádza. Pred zmenou veci s rozhodnutím ho prečítaj; commit nesie ID.

### P-009: Pôvod pamäte
`operator` sa neoveruje, `derived` odtlačkom zdrojov, `observed` pred nevratnou akciou. Rozchod s realitou oprav hneď. Expirácia podľa času je zakázaná.

### P-010: Limit indexu
Pri prekročení limitu indexu spusti `workflow:consolidate` po jednotke práce; platný údaj kvôli limitu NEMAŽ.
