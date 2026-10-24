-- name: booksByStatus :many
SELECT id, status FROM books WHERE status = :status;
