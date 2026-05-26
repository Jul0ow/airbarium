---
name: verify
description: Run typecheck + lint + unit tests. Optionally run integration tests (requires docker compose). Use before pushing or creating a PR to verify the build is clean.
---

Run the following verification steps in order and report any failures:

1. **Typecheck**: `bun run typecheck`
   - Report any TypeScript errors with file and line number.

2. **Lint**: `bun run lint`
   - Report any Biome violations.

3. **Unit tests**: `bun test tests/unit/`
   - Run unit tests only (no docker compose required).
   - Report failing tests with output.

4. **Integration tests** (only if the user passed `--integration` or `--all`):
   - First verify docker compose services are healthy: `docker compose ps`
   - If postgres or garage are not running, stop and tell the user to run `docker compose up -d` first.
   - Then: `bun test tests/integration/`

After all steps, print a summary:
- ✓ / ✗ for each step
- Total pass/fail count
- If anything failed, list the specific errors and suggest fixes.
