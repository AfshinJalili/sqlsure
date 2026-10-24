-- expect: 5:1 Duplicate query name "q"
-- name: q :one
SELECT 1 AS one;

-- name: q :one
SELECT 2 AS two;
