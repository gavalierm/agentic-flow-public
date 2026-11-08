# scripts/

Zdieľaná logika (knižnica) pre `bin/` a `hooks/`: čítanie `.workflow.json` a `local/workflow.json` (P-024), politika (P-017),
git operácie brain (P-040), normalizácia kľúčov (P-031, P-049), napojenie na klienta pošty `agentic-comms` (P-041: cesta z konfigurácie, limit 2 s, cache počtu u klienta),
katalóg dát projektu (`catalog/`: konfigurácia, scan, profily, find, prehľad, PreToolUse; P-031), materiály témy (`materialy.mjs`: limit, záznam; P-062), konce riadkov (`eol.mjs`, P-040).
Žiadna logika nesmie závisieť od harnessu (P-017) ani od konkrétnej inštancie (P-004).
