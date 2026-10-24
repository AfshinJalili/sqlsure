-- name: createAuthor :one
INSERT INTO authors (name, email) VALUES (:name, :email?) RETURNING id, name, email;

-- name: renameBook :one
UPDATE books SET title = :title WHERE id = :id RETURNING id, title;

-- name: deleteBook :execrows
DELETE FROM books WHERE id = :id;

-- name: archiveAll :exec
UPDATE books SET status = 'archived';
