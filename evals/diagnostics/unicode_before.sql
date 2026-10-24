-- expect: 3:25 column "nope" does not exist
-- name: q :many
SELECT 'héllo 🌍' AS x, nope FROM authors;
