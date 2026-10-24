-- name: booksWithAuthors :many
SELECT b.title, a.name AS author FROM books b JOIN authors a ON a.id = b.author_id;

-- name: authorsWithBooks :many
SELECT a.name, b.title FROM authors a LEFT JOIN books b ON b.author_id = a.id;

-- name: everything :many
SELECT a.name, b.title FROM authors a FULL JOIN books b ON b.author_id = a.id;

-- name: lastBook :many
SELECT a.name, lb.title FROM authors a
LEFT JOIN LATERAL (SELECT title FROM books WHERE author_id = a.id ORDER BY id DESC LIMIT 1) lb ON true;
