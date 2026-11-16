### P-036: Téma
Jednotkou paralelnej práce je téma (`workflow:topic`). Kódová téma pracuje iba vo svojom worktree na vetve `topic/<id>`; do cieľovej vetvy každého cieľového repa ju zlúči `done` i `done --topic` bez otázky (chránenú vetvu iba žiadosťou o zlúčenie).

### P-037: Držiteľ témy
Tému drží jedno vlákno (zámok); `claim --force` iba na výslovný pokyn operátora. Pri `lock lost` (zápis to overí) na téme ďalej NEPRACUJ.

### P-011: Handover
Téma má jeden handover so sekciami Zadanie, Hotové, Ďalší krok, Súbory, Otvorené otázky, Úlohy pre operátora (iba to, čo ďalšia session potrebuje), `save handover` po každej zmene stavu a pred `/clear`. Ďalší krok je iba krok vykonateľný bez odpovede (aj viac položiek); čo na odpoveď čaká, patrí do Otvorených otázok. Zmenu Zadania (operátor vo vlákne, pokyn supervisora) zapíš hneď s pôvodom. Pri prevzatí porovnaj „Hotové“ so súbormi a vetvami; pri rozchode sa spýtaj.

### P-012: Odbočenie z témy
Správu mimo témy ulož (P-007), upozorni na odbočenie a ponúkni novú tému; tu ju NERIEŠ.

### P-026: Pokračovanie
Ďalší krok v handoveri NIE JE dôvod ukončiť ťah: urob ho, inak skonči podľa P-061 a workflow vlákno zobudí „continue from handover“. Po kompakcii je podkladom handover; novú session navrhni až po `done --topic`.

### P-038: Identita vlákna
Identita je `thread <id>` zo stavového riadku, nie z pamäte; bez stabilného ID tému NEZABERAJ.
