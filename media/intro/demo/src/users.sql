-- name: getUser :one
SELECT id, email,
       display_name,
       created_at
FROM users
WHERE id = :id;
