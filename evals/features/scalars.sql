-- name: bookScalars :many
SELECT id, price, pages, rating, weight, cover, isbn, published_on, read_time, location FROM books;
