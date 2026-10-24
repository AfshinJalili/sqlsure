-- name: search :many
SELECT id FROM books WHERE title ILIKE :q OR subtitle ILIKE :q LIMIT :limit;

-- name: noParams :many
SELECT id FROM books;

-- name: tricky :many
SELECT id::text AS id_text, ':notaparam' AS literal, $body$ :alsonot $body$ AS dollar FROM books WHERE title = :title -- :comment
;
