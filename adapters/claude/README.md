# adapters/claude/

Adaptér pre Claude Code (P-017). `node <plugin>/bin/adapter.mjs claude-code` v koreni projektu vygeneruje:

- `<project>/.claude/settings.json`: `enabledPlugins` (`workflow@skills-dir`), `permissions` (ask z politiky, vlastné `allow` operátora ponechá, flow-public#96; deny vzor na brain mimo koreňa projektu je doplnková ochrana, hlavná je pre-commit brain, P-015/P-040), `autoMemoryEnabled: false`, `autoCompactWindow`,
- `<project>/.workflow.json` (ak chýba) s relatívnou cestou k brain,
- záznam `.claude/skills/` v `.gitignore` projektu.

Skilly brain (`skills/operator/`, `skills/agentic/`) sa do `<project>/.claude/skills/` **kopírujú** pri každom SessionStart (generovaný priečinok, prepíše sa). Symlinky sa nepoužívajú (P-017, P-024, P-032).

Prekladá iba formát; logika je v `scripts/`. Hooky, skilly a agenti idú z pluginu, nie z adaptéra.
