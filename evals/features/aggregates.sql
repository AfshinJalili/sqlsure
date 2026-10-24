-- name: stats :one
SELECT count(*) AS n, count(pages) AS with_pages, sum(pages) AS total_pages, max(price) AS top_price,
       coalesce(sum(pages), 0) AS total_or_zero
FROM books WHERE author_id = :authorId;

-- name: ranked :many
SELECT id, row_number() OVER (ORDER BY price) AS rn, lag(title) OVER (ORDER BY price) AS prev FROM books;

-- name: hasBooks :one
SELECT EXISTS (SELECT 1 FROM books WHERE author_id = :authorId) AS has_books;
