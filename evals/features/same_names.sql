-- name: authorAndBook :many
SELECT a.id, b.id, b.title FROM authors a LEFT JOIN books b ON b.author_id = a.id;
