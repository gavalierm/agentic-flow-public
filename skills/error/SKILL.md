---
name: error
description: Použi po každej chybe (vždy ju aj nahlásiš správcovi workflow) – operátor hlási „nefunguje to“ / „to je chyba“, príkaz zlyhá druhýkrát, pracovník vrátil neprázdne „Failures“, alebo si tvrdil niečo nepravdivé. Chyba sa stáva skillom alebo pravidlom.
argument-hint: "[list | check <tool> | resolve <n>]"
---

# error – chyba sa stáva skillom (P-003, P-028)

1. Oprav chybu a nájdi postup, ktorý funguje; over ho jedným úspešným spustením (P-020).
2. Zisti, kam poučenie patrí: chyba nástroja alebo postupu → skill; chyba správania agenta (nevyžiadaná zmena, neoverené tvrdenie, práca mimo témy) → kód, ktorý ju vynúti bez agenta (hook s rozhodnutím, skript, služba; vo vlastnom kóde skill `fix`, inak hlásenie správcovi workflow, P-015) a pravidlo s `save rule … --enforced-by <súbor>`; pravidlo iba v texte (`--unenforced "<prečo>"`) len vtedy, keď kód porušenie overiť nevie. Nie najprv pravidlo a kód až po opakovaní, lebo textové pravidlo sa poruší znova (operátor 2026-11-02).
3. `node ${CLAUDE_PLUGIN_ROOT}/bin/error.mjs check "<nástroj alebo druh práce>"` – ak skill existuje, poučenie zapracuj do jeho celého tela a ulož ho `--content "<celé telo>" --replace`; nový nevytváraj.
nie pripojenie poučenia ako ďalšej sekcie, lebo skill sa stane zlepencom pokynov, ktoré sa opakujú alebo si odporujú (operátor 2026-11-08).
4. Nový skill ulož cez `workflow:save`: `save.mjs skill <name> --description "Použi, keď ..." --origin error --content "<funkčný postup>\nnie <zlý spôsob>, lebo <prečo>"`. Popis je trigger formulovaný situáciou. Ak sa chyba zopakovala napriek skillu, oprav trigger alebo kroky.
5. Nahlás chybu správcovi workflow: `node <plugin>/bin/error.mjs report --title "<krátko>" --text "chyba: <čo sa stalo>; príčina: <prečo>; uložené: <skill/pravidlo>"`. Skript pošle poštu do témy správcu; keď ju tento server pošty nemá (iná inštancia), pošta nebeží alebo správu nikto neprevezme, založí issue vo verejnom repe workflow (text očistí od ciest, názvov projektu, adries a tajomstiev); bez prístupu ku GitHubu zapíše koncept do `scratch/`. „Nahlásené“ píš iba pri jeho riadku `reported: …` (pri issue daj operátorovi odkaz); pri `NOT reported` povedz operátorovi, že hlásenie neodišlo, a daj mu súbor. Zvonček „no reply“/„undelivered“ k hláseniu: `error.mjs report --from <id>`.
   nie `comms send --to <téma správcu>` a „nahlásil som“, lebo na inom stroji téma správcu neexistuje a správa ostala pozdržaná na jeho serveri (2026-11-07). Adresáta hlásení mení iba `node <plugin>/bin/brain.mjs maintainer --comms <projekt>/<téma>|none --repo <url>|none` (na pokyn operátora; `--comms none` = rovno issue); tému správcu, ktorú server pošty nemá, si skript zapamätá na 7 dní a poštu vynechá. Hlási sa každá chyba, aj opravená; samotné „moja chyba bola…“ operátorovi nestačí, lebo z poučenia v jednom brain sa nikto iný nedozvie. Ak držíš tému `workflow-dev`, chybu rieš priamo v nej (skript to odmietne).
6. Zlyhania pracovníkov a opakované zlyhania príkazov sú v `error.mjs list`; po spracovaní `error.mjs resolve <n>`.

Nie zoznam chýb, ale prevencia v skille. Skilly z chýb sa nemažú podľa veku.
