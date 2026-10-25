-- name: archived :many
SELECT id, title FROM archive.books;

-- name: odd :many
SELECT "Odd Name" FROM books;

-- name: fromView :many
SELECT id, title FROM live_books;

-- name: Json :many
SELECT id FROM archive.books;
