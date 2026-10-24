-- expect: 3:35 Positional parameters
-- name: q :many
SELECT id FROM authors WHERE id = $1;
