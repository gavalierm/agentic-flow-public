---
name: secrets
description: Použi, keď pracuješ s tajomstvom (heslo, token, kľúč, súbor z request_secret): kontroluješ jeho formát alebo platnosť, kopíruješ ho alebo o ňom niečo vypisuješ.
---

# secrets – tajomstvo nikdy v prepise (P-018, P-003)

1. Z tajomstva vypisuj iba booleany a dĺžky: obsahuje oddeľovač (`@`, `:`), počet častí, dĺžka každej časti, zhoda so vzorom (regex → true/false).
2. Časť tajomstva (napr. doménu adresy) vypíš iba po overení, že zodpovedá vzoru, ktorý ju robí verejnou (e-mail pred `@`); inak iba false.
3. Overenie prihlásením (SMTP, API) vypíše iba OK/FAIL a typ chyby, nie text odpovede, ktorý môže obsahovať vstup.
4. Tajomstvo odovzdávaj cestou k súboru (`<projekt>/local/` alebo cieľ služby s právami 600), nie hodnotou v príkaze ani v správe.
5. Tajomstvo pre MCP server z `.mcp.json`: `${VAR}` sa tam dosadzuje z prostredia, v ktorom Claude Code štartoval; hodnotu daj serveru zo súboru v `<projekt>/local/` (spúšťací skript servera ho načíta) alebo z prostredia spustenia; riadok štartu `mcp: server … gets the literal ${…}` hlási premennú, ktorá sa nedosadí. Nie hodnotu iba v `env` súboru `.claude/settings.json` či `.claude/settings.local.json`, lebo platí pre Bash, ale server dostal doslovné `${VAR}` a vracal 401 (report-ef63d010, 2026-11-13).
6. Keď sa časť tajomstva dostala do prepisu: povedz to operátorovi hneď (čo a koľko znakov, nie hodnotu) a navrhni zmenu tajomstva.
nie `split()` a výpis časti (napr. `u.split('@')[-1]`), lebo bez oddeľovača vráti celú hodnotu a tajomstvo sa ocitne v prepise (2026-11-03).
