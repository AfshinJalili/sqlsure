-- expect: 2:1 two columns named "id"
-- name: q :many
SELECT a.id, b.id FROM authors a JOIN books b ON b.author_id = a.id;
