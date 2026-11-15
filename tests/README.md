# tests/

Testy `node:test` (P-034), bez závislostí, nad dočasnými git repami; spúšťa ich `npm test` (celá sada najviac 60 s). V sade sú iba kritické testy (D-0061, D-0062).

## Jadro alebo TTL

Každý testovací súbor (`tests/**/*.test.mjs`) má v prvých 5 riadkoch jednu hlavičku:

- `// keep: core` — test jadra: chráni pred nevratnou škodou alebo stratou dát, alebo overuje základný tok, bez ktorého workflow nefunguje: ochrana dát (mazanie a prepis nesledovaných súborov, P-018), zvonček a správa nie je pokyn (P-047), jeden zapisovač brainu (P-013), tajomstvá a úniky (P-004), inštalácia vydania, `done` a zlúčenie témy, `migrate`, štart session, zápis cez `save`, zabratie témy, pošta (doručenie, odpoveď), povolenia generované adaptérmi.
- `// ttl: YYYY-MM-DD` — každý iný test, napr. test jednej opravy; dátum je 30 dní od vzniku testu.

`npm test` najprv spustí `node tests/ttl.mjs check`: súbor bez platnej hlavičky zastaví sadu s hláškou, čo doplniť (to isté kontroluje `ttl.test.mjs`).

## Výber testov od zmeny

`npm test -- --since <ref>` (D-0085: dočasný test beží iba pri zmene kódu, ktorý chráni) spustí všetky testy `// keep: core` a z dočasných (`// ttl:`) iba tie, ktorých chránený súbor alebo samotný test sa zmenil v `<ref>..HEAD` (od spoločného predka) alebo je zmenený necommitnutý či nesledovaný. Chránené súbory testu sa počítajú bez hlavičky, jedným `git log` pre všetky testy: súbory mimo `tests/` a mimo `*.md` z commitu, ktorý test pridal (aj cez premenovanie), a súbory, ktoré test priamo importuje (relatívne importy). Zmena spoločnej infraštruktúry (`tests/helpers.mjs`, `package.json`, `tests/ttl.mjs`, `scripts/test-slot.mjs`) spustí celú sadu. Pred behom vypíše `tests: core N + changed M of K temporary (since <ref>)` (pri infraštruktúre doplní `; shared infrastructure changed: <súbory>`). Bez `--since` beží celá sada ako predtým (`node tests/ttl.mjs run`).

## Slot testov

Celá sada beží cez `scripts/test-slot.mjs` (D-0069; preťaženie 2026-11-15: desať tém naraz spustilo celé testy, záťaž 41 na 4 jadrách): na stroji najviac 2 celé behy testov naraz, spoločne pre `agentic-flow` a `agentic-comms` (ten istý skript). Slot je súbor `slot-<n>.json` v `~/.local/state/agentic/test-slots`, zabratý výlučným vytvorením pod krátkym zámkom priečinka; beh ho každých 5 s obnoví, takže slot ukončeného behu (mŕtve pid alebo bez obnovy 60 s) sa prevezme. Ďalší `npm test` vypíše `waiting for a test slot (…)` a čaká; po získaní `test slot taken after <n> s`. Jeden súbor `node --test tests/<súbor>.test.mjs` slotom nejde a limit nemá. Premenné: `AGENTIC_TEST_SLOTS` (počet, predvolene 2), `AGENTIC_TEST_SLOTS_DIR` (priečinok), `AGENTIC_TEST_SLOT_HELD` (beh vnútri držaného slotu nečaká na ďalší). Počas práce spúšťaj iba testy, ktorých sa zmena týka; celú sadu raz na konci.

## Ako sa píše test

- Test jadra overuje zmluvu správania (čo platí vždy), nie jednu historickú chybu; podobné prípady patria do jedného testu, nie do nového súboru.
- Oprava chyby: najprv over, či chybu nepokrýva test jadra; ak áno, dopíš prípad do neho. Inak test opravy so `// ttl:` (30 dní); po vypršaní ho rotácia zmaže.
- Test nepoužíva absolútne cesty, mená osôb ani súkromných projektov (P-004; kontroluje `lint.test.mjs`).

## Rotácia

`node tests/ttl.mjs expire` zmaže testy po ich `ttl` (`git rm`) v samostatnom commite so zoznamom v tele a vypíše ich (`removed <súbor> (ttl <dátum>)`, na konci `expired: <n>` alebo `expired: none`); `--dry` iba vypíše, `--today YYYY-MM-DD` mení dnešný deň. Vydanie ho volá pred testami.

## Pošta

Integračné testy pošty (`comms-skill`, `reply-state`) spúšťajú dočasnú inštanciu `agentic-comms` ako detský proces v dočasnom priečinku a po teste ju zastavia. Klient sa hľadá v `AGENTIC_COMMS_DIR`, vedľa klonu pluginu (`../agentic-comms`) alebo z worktree témy v `<doména>/agentic-comms`; bez neho sa tieto testy preskočia.
