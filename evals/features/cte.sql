-- name: prolific :many
WITH counts AS (SELECT author_id, count(*) AS n FROM books GROUP BY author_id)
SELECT a.name, counts.n FROM authors a JOIN counts ON counts.author_id = a.id;

-- name: unionTitles :many
SELECT title FROM books UNION SELECT title FROM archive.books;
