---
name: proposal
description: Použi, keď operátorovi predkladáš návrh (riešenie, plán, architektúru, porovnanie možností, špecifikáciu, rešerš so záverom) alebo report výsledku práce. Je to jedna HTML stránka zobrazená vo vlákne, nie súbor .md ani dlhý text odpovede (P-077).
---

# proposal – návrh ako HTML stránka (P-077)

Operátor návrh prezerá, nečíta. Návrh do 5 riadkov ostáva v texte odpovede; dlhší je stránka.

1. Súbor: `<pracovné súbory>/navrh-<názov>.html` (cesta pracovných súborov zo štartu, P-052). Súbor `.md` s návrhom nevzniká.
2. Obsah v tomto poradí, bez opakovania kontextu, ktorý operátor pozná:
   - nadpis a riadok **Rozhodnúť:** čo má operátor rozhodnúť, s odporúčaním; ak nič (P-059: jeho návrh, s ktorým súhlasíš), „nič, nasadzujem …“;
   - problém v 1–2 vetách;
   - návrh vizuálne: schéma toku (inline SVG alebo bloky s šípkami), tabuľka zmien (čo / kde / prečo);
   - možnosti ako karty alebo tabuľka, odporúčaná prvá a označená, pri každej cena a riziko;
   - dopady, riziká a čo si neoveril (P-019) v bodoch;
   - súbory a príkazy iba ako krátky zoznam na konci.
3. Forma: jeden súbor bez externých zdrojov (CSS v `<style>`, SVG vnútri, žiadne CDN), `<meta name="viewport">`, šírka do 960 px, na úzkej obrazovke bez vodorovného posunu; farby ako premenné na `:root` a `@media (prefers-color-scheme: dark)`, telo s vlastným pozadím; systémové písmo. Kontrast textu voči pozadiu aspoň WCAG AA (4,5 : 1) v oboch režimoch, aj pri vedľajšom texte; nie tlmený sivý text na sivom podklade. Rozhodnutie, pozornosť, chyba a varovanie sú zvýraznené farbou, ikonou a miestom navrchu, nie iba vetou v texte. Text po slovensky.
4. Zobrazenie: v T3 `html_preview` s cestou k súboru, potom `html_render` (vlákno stránku ukáže); bez T3 absolútna cesta k súboru v odpovedi. Server nespúšťaj.
5. Odpoveď: 1–3 riadky k návrhu (čo navrhuješ, odporúčanie) a otázka v bloku Otázky, ak treba rozhodnutie (P-061). Text stránky do odpovede nekopíruj.
6. Uchovanie: návrh, ktorý stojí za uchovanie (rozhodnutie sa naň odvoláva, téma pokračuje podľa neho), ulož `save.mjs result <súbor> --as navrh-<názov>.html` (P-067); zmenu návrhu `--replace`.

## Report výsledku

Report výsledku práce (porovnanie, migrácia, kontrola dát) je stránka podľa krokov 3–6 s týmto obsahom:

1. Navrchu jeden overený súhrn: čísla z vlastného pozorovania v tejto session, nie prevzaté z výsledku pracovníka ani odvodené (P-019, P-053). Číslo, ktoré si neoveril, je tak označené.
2. Potom iba to, čo vyžaduje rozhodnutie, kontrolu alebo pozornosť operátora: zoznam položiek, nie ukážka. Chyby a varovania sú vlastná zvýraznená sekcia; nikdy nie sú tiché ani schované v texte. Bez nálezu: jeden riadok „nič nevyžaduje pozornosť“.
3. Bez ukážok toho, čo je v poriadku, a bez metrík, ktoré nemajú rozhodovací účel.
4. Výsledok jednej práce je jeden dokument: ďalšie zistenia doplň do neho (`--replace`, artefakt publikuj s jeho `url`), nová stránka nevzniká. Pred novou stránkou pozri stránky témy: tá istá práca alebo predmet → prepíš ju; iná práca a si si istý → nová; nie si istý → spýtaj sa operátora dialógom, či novú, alebo prepísať ktorú. Artefakt z vlákna T3 zmazať nejde (potvrdenie mazania sa v ňom nedá položiť), preto zbytočný nevytváraj. Prvý nový artefakt v téme, ktorá už stránky má, hook raz zamietne a vypíše ich; opakovanie prejde.

nie ukážka 24 správnych riadkov z 11 664 ani samostatná stránka namiesto doplnenia, lebo operátor stránku prerábal 4× v jednej session („chcem len zoznam toho, čo treba skontrolovať alebo vyžaduje pozornosť“, 2026-11-17).
nie nový artefakt bez pohľadu na stránky témy, lebo vznikli 2 takmer rovnaké reporty a zbytočný sa z vlákna nedal zmazať (operátor 2026-11-18).

Nie je to návrh: dokument, ktorý má byť v repe ako Markdown (README, dokumentácia kódu), a správa inému agentovi (pošta je text, P-041).
