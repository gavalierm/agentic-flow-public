### P-036: Téma
Jednotkou paralelnej práce je téma (`workflow:topic`). Kódová téma pracuje iba v `../<project>-topics/<id>/` na vetve `topic/<id>`; do hlavnej vetvy iba cez `done --topic`.

### P-037: Držiteľ témy
Tému vedie jedno vlákno; `claim --force` iba na výslovný pokyn operátora. Nedržiteľ sa pri zápise zastaví.

### P-011: Handover
Téma má jeden handover (15 riadkov: Zadanie, Hotové, Ďalší krok, Súbory, Otvorené otázky), `save handover` po každej zmene stavu a pred `/clear`. Pri prevzatí porovnaj „Hotové“ so súbormi; pri rozchode sa spýtaj.

### P-012: Odbočenie z témy
Správu mimo témy ulož (P-007), upozorni na odbočenie a ponúkni novú tému; tu ju NERIEŠ.

### P-026: Pokračovanie
Ďalší krok v handoveri NIE JE dôvod ukončiť ťah: urob ho; inak skonči stavom `čakám` s budíkom alebo `otázka` (P-061). Po kompakcii je podkladom handover; novú session navrhni až po `done --topic`.

### P-038: Identita vlákna
Identita je `thread <id>` zo stavového riadku, nie z pamäte; bez stabilného ID tému NEZABERAJ.
