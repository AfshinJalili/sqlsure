# sqlsure example

```sh
npm install
npm run typecheck                                       # tsc --runExternalCode, including the .sql files
npm test                                                # Vitest, with sqlsure/vite in vitest.config.ts
psql "$DATABASE_URL" -f db/schema.sql                   # once
DATABASE_URL=postgres://... npm start                   # node --import sqlsure/register src/main.ts
DATABASE_URL=postgres://... npm run start:bun           # the same under Bun, with sqlsure/bun
```

Try it: delete `display_name` from `db/schema.sql` and run the type check again. The error points
at `src/users.sql`, line 2, column 19 (and at the INSERT on line 5).
