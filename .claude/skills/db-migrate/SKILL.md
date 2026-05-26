---
name: db-migrate
description: Generate and apply Drizzle migrations after schema changes. Checks that docker compose postgres is running before migrating. Use whenever you modify files in src/db/schema/.
---

Run the following steps:

1. **Check postgres is running**:
   ```
   docker compose ps postgres
   ```
   If the postgres container is not running or not healthy, stop and tell the user to run `docker compose up -d` first.

2. **Generate migration**:
   ```
   bun run db:generate
   ```
   Show the user which migration file(s) were created (name and path).

3. **Apply migration**:
   ```
   bun run db:migrate
   ```
   Report success or any errors.

4. If migration fails, show the full error output and suggest whether it looks like a schema conflict, a missing env var (DATABASE_URL), or a postgres connectivity issue.
