-- expect: 3:1 One statement per query
-- name: q :exec
DELETE FROM books; DELETE FROM authors;
