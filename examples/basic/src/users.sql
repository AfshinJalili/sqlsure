-- name: getUser :one
SELECT id, email, display_name, created_at FROM users WHERE id = :id;

-- name: createUser :one
INSERT INTO users (email, display_name) VALUES (:email, :displayName?)
RETURNING id, email;

-- name: usersWithPostCounts :many
SELECT u.email, count(p.id) AS posts, max(p.title) AS latest_title
FROM users u LEFT JOIN posts p ON p.author_id = u.id
GROUP BY u.email;

-- name: deleteUser :execrows
DELETE FROM users WHERE id = :id;
