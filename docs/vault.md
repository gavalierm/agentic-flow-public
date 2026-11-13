# Vault vedomostí pre Obsidian

`vault.mjs` poskladá zo všetkých úložísk vedomostí stroja (brainy a `agentic/` rep domén) jeden priečinok, ktorý sa dá otvoriť v Obsidiane ako vault. Je iba na čítanie: zdroj pravdy ostáva v úložiskách a zapisuje sa ďalej iba cez `save.mjs`. Úprava vo vaulte sa pri ďalšom zostavení prepíše.

## Čo vault obsahuje

- `<úložisko>/memory`, `decisions`, `rules`, `skills/<meno>.md`, `handovers/<téma>.md` (brain: `topics/*/handover.md` bez `archive`; repo: `HANDOVER.md`), `docs/...` (ostatné `.md` z `agentic/` repa). Dve úložiská s rovnakým menom dostanú priečinok `<doména>-<meno>`.
- Nikdy `logs/`, `local/`, `scratch/`, `topic.json`, `.claude/`.
- Odkazy ako wikilinky s cestou od koreňa vaultu a zobrazeným pôvodným textom: holé `D-NNNN` (vlastné úložisko), `<úložisko>/D-NNNN` (aj podľa mena priečinka vaultu), kľúče pamäte `<typ>-<meno>` (vlastné úložisko prednostne), `relates_to` a `supersedes` vo frontmatter ako zoznam `"[[cesta|text]]"` (Obsidian property odkazy). Čo sa nerozloží (neznáme ID, `P-NNN`, cesta k súboru, text v bloku kódu alebo v spätných apostrofoch), ostane text. Riadky `key:` a `id:` sa nemenia.
- `README.md` (index úložísk s počtami a odkazmi na každý záznam), `vedomosti.base` (Obsidian Bases: tabuľky pamäte a rozhodnutí), `.obsidian/app.json` (iba ak neexistuje; režim čítania), `.gitignore` (`.obsidian/workspace*.json`), `.vault-manifest.json` (zoznam vygenerovaných súborov; podľa neho prebudovanie maže staré).

## Príkazy

```
node bin/vault.mjs build --out <priečinok>      # zostaví vault
node bin/vault.mjs publish --out <priečinok>    # build; ak je priečinok git repo a niečo sa zmenilo: commit "vault: rebuild" a push
```

Výstup: `vault <out>: stores N, files M, links K, unresolved U` (`files` = záznamy skopírované z úložísk; `unresolved` = odkazy na rozhodnutia a kľúče, ktoré sa nenašli, `P-NNN` a cesty sa nepočítajú). `publish` pridá riadok `changed` alebo `unchanged`; mimo git repa odmietne a nič nezapíše. Priečinok `--out` nesmie obsahovať úložisko ani ležať v priečinku, ktorý vault číta.

## Desktop

1. Súkromné repo vaultu (napr. `agentic-vault`) naklonuj na stroji, kde bežia agenti; `vault.mjs publish --out <klon>` (ručne alebo časovačom) ho obnoví a pushne.
2. Na čítacom počítači naklonuj to isté repo a v Obsidiane ho otvor ako vault (Open folder as vault).
3. Komunitný plugin Obsidian Git nastav na automatický pull; vault ostáva iba na čítanie, nič z neho nepushuj.

## Mobil

Obsidian Git na mobile autor pluginu označuje za nestabilný. Možnosti: Obsidian Sync (platená služba operátora; pracovník ju nepoužíva) alebo iný prenos priečinka (synchronizácia súborov mimo gitu).
