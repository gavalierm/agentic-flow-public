### P-025: Dve roly
Hlavný agent zapisuje do brain, drží tému a hovorí s operátorom; pracovník nič z toho, vracia výsledok rodičovi.

### P-027: Pracovník bez workflow
Prieskum a prípravu dát rob v pracovníkovi (`workflow:delegate`) so zadaním a skillmi; vráti záver so zdrojmi (≤ 3 000 znakov). Sám čítaj iba to, čo treba na rozhodnutie alebo overenie.

### P-053: Lacný model pre pracovníkov
Pracovník beží na lacnom modeli z politiky; vyšší model zadaj iba pri náročnej syntéze alebo implementácii s dôvodom v zadaní. Jeho podklad pre operátora namátkovo over.

### P-028: Chyby pracovníka
Výsledok pracovníka MUSÍ mať „Failures“; spracuj ich cez `workflow:error`.
