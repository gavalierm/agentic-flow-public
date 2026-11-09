---
name: catalog
description: Použi pri každej úlohe nad dátami klienta v zdroji katalógu (CSV, PDF, obrázky, zip): najprv find a show, CSV dotazuj cez sql, nikdy ls, grep ani cat po zdroji.
argument-hint: "find <slová> | show <cesta> | sql <cesta> \"<SELECT>\""
---

# catalog – katalóg dát projektu (P-031)

Katalóg je index súborov zdrojov z `catalog.sources` v `<repo>/local/workflow.json` a priečinka `<repo>/materialy/` (zdroj `materialy`, automaticky). Bez zdroja je vypnutý a nič nerobí. Štart relácie ho obnoví (riadok `katalóg <zdroj>: …`); ručne: `node ${CLAUDE_PLUGIN_ROOT}/bin/catalog.mjs scan`. Zdroj pridáva iba výslovný pokyn operátora a je to priečinok dát klienta mimo práce tém; nie priečinok, do ktorého zapisuje téma (`docs/…`), ani pri audite či otázke, lebo zdroj `ro` platí pre všetky vlákna projektu a ich zápis tam hook odmietne (Skarper 2026-11-09).

1. `catalog.mjs find <slová>` – cesty a jednoriadkové popisy (najviac 20), nikdy obsah. Filtre `--kind csv|pdf_text|pdf_scan|image|archive`, `--source <n>`; `--all` zapíše úplný zoznam do `<repo>/scratch/`. `bin/find.mjs <slová>` pridá blok katalógu za výsledky brain.
2. `catalog.mjs show <zdroj>/<cesta>` – celý riadok: pre CSV oddeľovač, kódovanie, hlavičku, typy, min/max a hodnoty nízkej kardinality (PII stĺpce sú maskované `***`).
3. CSV nečítaj: `catalog.mjs sql <cesta> "SELECT … FROM t …"` (tabuľka `t` je ten CSV, iba čítanie, vyžaduje `duckdb` v PATH; bez neho vypíše návrh `awk`). Typy a stĺpce vezmi zo `show`, nehádaj.
4. PDF: `pdftotext -f <od> -l <do>` iba potrebných strán (`pdf_scan` je sken bez textu); obrázky čítaj (Read) iba vybrané, nie celý priečinok.
5. `catalog.mjs profile` doplní profily (rozpočet `--budget <s>`), `overview` prepíše `local/catalog/human/INDEX.md` (počty, duplikáty, najväčšie súbory, posledné zmeny), `status` ukáže stav, nástroje a poslednú chybu.

Zdroj s režimom `ro` je iba na čítanie: zápis doň hook zamietne, výsledky patria do `<repo>/materialy/<téma>/` (skill `materialy`), medzivýsledky do `<repo>/scratch/`. Nikdy `ls -R`, `find`, `grep -r` ani `cat` po zdroji: katalóg ich nahrádza a drží cesty mimo kontextu. Duplikáty (`status: duplicate`, `dup_of`) neprocesuj dvakrát.
