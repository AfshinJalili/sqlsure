-- name: getUser :one
SELECT * FROM users WHERE id = :id;

-- name: getUserByEmail :one
SELECT id, email, display_name, is_admin FROM users WHERE email = :email;

-- name: listUsers :many
SELECT id, email, created_at, last_login, settings, tags FROM users ORDER BY id LIMIT :limit;

-- name: listProducts :many
SELECT id, sku, name, price, weight_grams, photo, ratings FROM products ORDER BY id;

-- name: productsWithCategory :many
SELECT p.id, p.name, c.name AS category_name, c.id AS category_id
FROM products p LEFT JOIN categories c ON c.id = p.category_id;

-- name: productsInCategory :many
SELECT p.id, p.name, c.name AS category_name
FROM products p JOIN categories c ON c.id = p.category_id
WHERE c.id = :categoryId;

-- name: categoryTree :many
SELECT child.id, child.name, parent.name AS parent_name
FROM categories child LEFT JOIN categories parent ON parent.id = child.parent_id;

-- name: orderTotals :many
SELECT o.id, o.status, sum(oi.quantity * oi.unit_price) AS total, count(oi.product_id) AS items
FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id, o.status;

-- name: userOrders :many
SELECT o.id, o.status, o.placed_on, o.shipped_at, u.email
FROM orders o JOIN users u ON u.id = o.user_id
WHERE u.id = :userId;

-- name: ordersByStatus :many
SELECT id, user_id, status FROM orders WHERE status = :status;

-- name: reviewsWithAuthors :many
SELECT r.id, r.stars, r.body, r.meta, u.email AS author_email
FROM reviews r LEFT JOIN users u ON u.id = r.user_id;

-- name: averageStars :one
SELECT avg(stars) AS avg_stars, max(stars) AS best, count(*) AS n FROM reviews WHERE product_id = :productId;

-- name: productSummary :many
SELECT id, name, category, review_count FROM product_summary;

-- name: recentActivity :many
WITH recent AS (
  SELECT user_id, max(placed_on) AS last_order FROM orders GROUP BY user_id
)
SELECT u.id, u.email, recent.last_order
FROM users u LEFT JOIN recent ON recent.user_id = u.id;

-- name: createUser :one
INSERT INTO users (email, display_name) VALUES (:email, :displayName?)
RETURNING id, email, display_name, created_at;

-- name: renameUser :one
UPDATE users SET display_name = :name WHERE id = :id RETURNING id, display_name;

-- name: deleteReview :execrows
DELETE FROM reviews WHERE id = :id;

-- name: touchLogin :exec
UPDATE users SET last_login = now() WHERE id = :id;

-- name: searchProducts :many
SELECT id, name, description FROM products
WHERE name ILIKE '%' || :term || '%' OR description ILIKE '%' || :term || '%';

-- name: topBuyers :many
SELECT u.email, count(o.id) AS orders, coalesce(sum(oi.quantity), 0) AS units
FROM users u
JOIN orders o ON o.user_id = u.id
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY u.email
ORDER BY orders DESC;

-- name: productExists :one
SELECT EXISTS (SELECT 1 FROM products WHERE id = :id) AS exists;

-- name: usersWithTag :many
SELECT id, email FROM users WHERE :tag = ANY (tags);

-- name: settingsKey :many
SELECT id, settings -> 'theme' AS theme, settings ->> 'lang' AS lang FROM users;

-- name: rankedProducts :many
SELECT id, name, row_number() OVER (ORDER BY price DESC) AS rank, lag(name) OVER (ORDER BY price DESC) AS prev_name
FROM products;
