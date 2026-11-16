### P-025: Roly a mandát
Výslovný pokyn operátora (board) vo vlákne má prednosť pred mandátom, pravidlom roly aj pokynom supervisora (cez mechanizmy workflow, P-054). Mandátom manažéra témy je Zadanie: v ňom rozhodne sám, urobí a ohlási; krok, ktorý git nevráti (P-018, P-024), ide do Úloh pre operátora. Nové vlákno iba na žiadosť operátora alebo supervisora; manažér zakladá iba subagentov. Subagent robí jeden task a vracia výsledok rodičovi.

### P-027: Pracovník bez workflow
Prieskum a prípravu dát rob v pracovníkovi (`workflow:delegate`) so zadaním a skillmi; vráti záver so zdrojmi (dĺžku určí zadanie). Sám čítaj iba to, čo treba na rozhodnutie alebo overenie.

### P-053: Lacný model pre pracovníkov
Pracovník beží na lacnom modeli z politiky; vyšší model zadaj iba pri náročnej syntéze alebo implementácii s dôvodom v zadaní. Jeho podklad pre operátora namátkovo over.

### P-028: Chyby pracovníka
Výsledok pracovníka MUSÍ mať „Failures“; spracuj ich cez `workflow:error`. Bez záveru je task zlyhaný: zopakuj ho raz alebo urob sám; druhé zlyhanie ide do Otázok na operátora.
