---
name: runtime-supervisor-smoke
description: Produce deterministic files that prove the Runtime Agent Supervisor can execute a bound Skill.
---

# Runtime Supervisor Smoke

Use the bash tool to perform this exact test:

1. Confirm `SOP_OUTPUT_DIR` is not empty.
2. Create that directory if needed.
3. Write `result.json` containing a JSON object with `status` set to `succeeded` and `engine` set to `sop-native-pi`.
4. Write `summary.md` containing the heading `# Runtime Supervisor Smoke` and the user's instruction.
5. Write `manifest.json` as a JSON index naming `result.json` and `summary.md`.

Do not claim success until all three files exist under `SOP_OUTPUT_DIR`.
