---
name: proposal
description: Použi, keď operátorovi predkladáš návrh: riešenie, plán, architektúru, porovnanie možností, špecifikáciu alebo rešerš so záverom. Návrh je jedna HTML stránka zobrazená vo vlákne, nie súbor .md ani dlhý text odpovede (P-077).
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
3. Forma: jeden súbor bez externých zdrojov (CSS v `<style>`, SVG vnútri, žiadne CDN), `<meta name="viewport">`, šírka do 960 px, na úzkej obrazovke bez vodorovného posunu; farby ako premenné na `:root` a `@media (prefers-color-scheme: dark)`, telo s vlastným pozadím; systémové písmo. Text po slovensky.
4. Zobrazenie: v T3 `html_preview` s cestou k súboru, potom `html_render` (vlákno stránku ukáže); bez T3 absolútna cesta k súboru v odpovedi. Server nespúšťaj.
5. Odpoveď: 1–3 riadky k návrhu (čo navrhuješ, odporúčanie) a otázka v bloku Otázky, ak treba rozhodnutie (P-061). Text stránky do odpovede nekopíruj.
6. Uchovanie: návrh, ktorý stojí za uchovanie (rozhodnutie sa naň odvoláva, téma pokračuje podľa neho), ulož `save.mjs result <súbor> --as navrh-<názov>.html` (P-067); zmenu návrhu `--replace`.

Nie je to návrh: dokument, ktorý má byť v repe ako Markdown (README, dokumentácia kódu), a správa inému agentovi (pošta je text, P-041).
