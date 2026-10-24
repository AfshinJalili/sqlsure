# sqlsure example

```sh
tsc -p . --noEmit --runExternalCode                     # type-check, including the .sql files
psql "$DATABASE_URL" -f db/schema.sql                   # once
DATABASE_URL=postgres://... node --import sqlsure/register src/main.ts
```

Try it: delete `display_name` from `db/schema.sql` and run the type check again. The error points
at `src/users.sql`, line 2, column 19 (and at the INSERT on line 5).
