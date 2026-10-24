-- expect: 4:30 column "bogus" does not exist
-- name: q :many
SELECT id FROM authors WHERE name = :someLongParameterName
                         AND bogus = 1;
