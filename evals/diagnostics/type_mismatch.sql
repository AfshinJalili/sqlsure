-- expect: 3:33 operator does not exist: integer = date
-- name: q :many
SELECT id FROM authors WHERE id = '2026-01-01'::date;
