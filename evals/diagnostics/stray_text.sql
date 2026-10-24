-- expect: 2:1 SQL outside a named query
SELECT 1;
-- name: q :one
SELECT 2 AS two;
