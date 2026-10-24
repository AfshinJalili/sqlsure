-- name: bookArrays :many
SELECT tags, scores, statuses FROM books;

-- name: booksWithTag :many
SELECT id FROM books WHERE tags && :tags;
