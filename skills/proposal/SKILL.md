---
name: proposal
description: Použi, keď operátorovi predkladáš návrh (riešenie, plán, porovnanie, špecifikáciu, rešerš so záverom), report výsledku (aj na slovo „report“) alebo prehľad stavu, čo je hotové a čo nie. Forma: ASCII diagram, HTML stránka či Artifact podľa obsahu; nie súbor .md ani dlhý text (P-077).
---

# proposal – návrh ako HTML stránka (P-077)

Operátor návrh aj report prezerá, nečíta. Slovo „report“ od operátora znamená jednu z týchto foriem; zvolíš ju sám podľa obsahu (operátor 2026-11-18):

| Forma | Kedy |
|---|---|
| ASCII diagram v odpovedi (blok kódu, do ~20 riadkov) | tok, štruktúra, stav či porovnanie, ktoré sa zmestia na jednu obrazovku; návrh do 5 riadkov ostáva textom |
| HTML stránka vo vlákne (kroky 1–6) | väčší návrh či report na jedno prezretie v tejto téme |
| Artifact (stránka na claude.ai, nástroj Artifact) | operátor ju otvorí znova, pošle ďalej alebo sa bude dopĺňať (jeden dokument, aktualizácia jeho `url`, „Report výsledku“ bod 4) |

Bez nástroja Artifact platí HTML stránka.

1. Súbor: `<pracovné súbory>/navrh-<názov>.html` (cesta pracovných súborov zo štartu, P-052). Súbor `.md` s návrhom nevzniká.
2. Obsah v tomto poradí, bez opakovania kontextu, ktorý operátor pozná:
   - nadpis a riadok **Rozhodnúť:** čo má operátor rozhodnúť, s odporúčaním; ak nič (P-059: jeho návrh, s ktorým súhlasíš), „nič, nasadzujem …“;
   - problém v 1–2 vetách;
   - návrh vizuálne: schéma toku (inline SVG alebo bloky s šípkami), tabuľka zmien (čo / kde / prečo);
   - možnosti ako karty alebo tabuľka, odporúčaná prvá a označená, pri každej cena a riziko;
   - dopady, riziká a čo si neoveril (P-019) v bodoch;
   - súbory a príkazy iba ako krátky zoznam na konci.
3. Forma: jeden súbor bez externých zdrojov (CSS v `<style>`, SVG vnútri, žiadne CDN), `<meta name="viewport">`, šírka do 960 px, na úzkej obrazovke bez vodorovného posunu; farby ako premenné na `:root` a `@media (prefers-color-scheme: dark)`, telo s vlastným pozadím; systémové písmo. Čitateľnosť podľa WCAG AA v oboch režimoch, meraná, nie odhadnutá:
   - text voči pozadiu, na ktorom leží, aspoň 4,5 : 1 (veľký text od 24 px aspoň 3 : 1), aj vedľajší text, štítok a popis v diagrame; nie tlmený sivý text na sivom podklade;
   - čiara a šípka diagramu voči pozadiu aspoň 3 : 1, aj „zrušené“ či „vypnuté“ (odlíš ich prerušovanou čiarou, nie bledou farbou);
   - text stránky aspoň 12 px; text v SVG aspoň 11 px pri šírke stĺpca 720 px: `viewBox` najviac 720 široký, alebo väčšie písmo (text v kresbe širokej 960 sa zmenší na tri štvrtiny);
   - farebný štítok: tmavá farba textu na svetlom podklade tej istej farby (v tmavom režime naopak), oranžová a žltá potrebujú tmavší odtieň než modrá.
   Pred zobrazením spusti `node ${CLAUDE_PLUGIN_ROOT}/bin/page-check.mjs <súbor>`: vypíše každú dvojicu farieb a veľkosť, ktorá nevyhovuje, s miestom. Stránku s nálezom hook nezobrazí. Rozhodnutie, pozornosť, chyba a varovanie sú zvýraznené farbou, ikonou a miestom navrchu, nie iba vetou v texte. Text po slovensky.
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
nie farby „od oka“, lebo operátor diagram siete neprečítal: popisy 11,5 px v kresbe širokej 960, sivý popis 2,5 : 1 a oranžový 3,9 : 1 („toto určite nespĺňa čitateľnosť, neviem to prečítať“, 2026-11-22).
nie nový artefakt bez pohľadu na stránky témy, lebo vznikli 2 takmer rovnaké reporty a zbytočný sa z vlákna nedal zmazať (operátor 2026-11-18).

## Mapa stavu

Prehľad, čo je hotové a čo nie (stav skillu, migrácie, plánu, práce po častiach; „ukáž stav“, „čo je hotové“, „kde sme“), je strom zo šablóny. Stránku nepíšeš, píšeš iba údaje:

1. Údaje: `<pracovné súbory>/stav-<názov>.json`:
   `{"title": "…", "root": {"name": "…", "note": "…"}, "areas": [{"name": "…", "items": [["done", "čo", "kde", "poznámka"]]}], "log": [["20. 11. 00:12", "čo sa zmenilo"]]}`
   - `root` je to, čoho stav ukazuješ (skill, projekt, migrácia); `areas` sú jeho schopnosti alebo časti práce (do ~8); `log` sú posledné zmeny, najnovšia prvá.
   - Položka je jedna vec, ktorú operátor pozná menom, nie súbor ani commit. `kde` (skill, skript, súbor) a `poznámka` sú nepovinné.
   - Stav položky: `done` hotové, `work` robí sa, `wait` čaká na operátora (poznámka = čo má urobiť), `miss` chýba, `off` zrušené (poznámka = prečo).
   - `done` iba po vlastnom overení (P-019); čo si neoveril naživo, napíš do poznámky položky.
2. Stránka: `node ${CLAUDE_PLUGIN_ROOT}/bin/status-map.mjs <údaje.json>` zapíše `stav-<názov>.html` vedľa údajov. Neznámy stav či prázdnu položku odmietne s miestom chyby.
3. Zobrazenie a uchovanie podľa krokov 4–6. Farby a veľkosti šablóny sú zmerané (WCAG AA), stránku z nej nekontroluješ. Je to jeden dokument práce („Report výsledku“ bod 4): pri zmene uprav údaje, spusti skript znova a publikuj s tým istým `url`; ulož údaje aj stránku.

Hotové sú malé štítky a nehotové veľké lístky, preto oko ide na to, čo ostáva. Nie vlastná stránka stavu ani tabuľka so stĺpcom „stav“, lebo strom zo šablóny operátor číta na jeden pohľad („extrémne prehľadný o tom, čo je spravené a čo nie“, 2026-11-20).

Nie je to návrh: dokument, ktorý má byť v repe ako Markdown (README, dokumentácia kódu), a správa inému agentovi (pošta je text, P-041).
