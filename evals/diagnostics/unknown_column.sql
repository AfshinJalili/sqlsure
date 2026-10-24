-- expect: 3:8 column "nope" does not exist
-- name: q :many
SELECT nope FROM authors;
