-- name: bookMeta :many
SELECT meta, extra, meta -> 'k' AS k, meta ->> 'k' AS k_text FROM books;

-- name: setMeta :exec
UPDATE books SET meta = :meta WHERE id = :id;
