-- name: getAuthor :one
SELECT id, name, email, created_at FROM authors WHERE id = :id;
