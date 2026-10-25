-- name: leftJoinRightSide :many
SELECT a.label AS a_label, b.label AS b_label FROM a LEFT JOIN b ON b.a_id = a.id;

-- name: rightJoinLeftSide :many
SELECT a.label AS a_label, b.label AS b_label FROM a RIGHT JOIN b ON b.a_id = a.id;

-- name: fullJoin :many
SELECT a.label AS a_label, b.label AS b_label FROM a FULL JOIN b ON b.a_id = a.id;

-- name: nestedJoin :many
SELECT a.label AS a_label, b.label AS b_label, c.label AS c_label
FROM a LEFT JOIN (b JOIN c ON c.b_id = b.id) ON b.a_id = a.id;

-- name: joinInSubquery :many
SELECT x.b_label FROM (SELECT b.label AS b_label FROM a LEFT JOIN b ON b.a_id = a.id) x;

-- name: cteOnNullableSide :many
WITH bs AS (SELECT a_id, label FROM b)
SELECT a.label AS a_label, bs.label AS b_label FROM a LEFT JOIN bs ON bs.a_id = a.id;

-- name: lateralLeftJoin :many
SELECT a.label AS a_label, last_b.label AS b_label
FROM a LEFT JOIN LATERAL (SELECT label FROM b WHERE b.a_id = a.id ORDER BY id DESC LIMIT 1) last_b ON true;

-- name: unionWithNull :many
SELECT label FROM a UNION ALL SELECT NULL;

-- name: unionInSubquery :many
SELECT u.label FROM (SELECT label FROM a UNION ALL SELECT NULL) u;

-- name: rollup :many
SELECT label, sum(n) AS total FROM a GROUP BY ROLLUP (label);

-- name: cubeGroups :many
SELECT label, n, count(*) AS cnt FROM a GROUP BY CUBE (label, n);

-- name: viewColumns :many
SELECT id, label FROM a_view;

-- name: scalarSubquery :many
SELECT a.id, (SELECT b.label FROM b WHERE b.a_id = a.id LIMIT 1) AS first_b FROM a;

-- name: aggregatesOnEmpty :one
SELECT max(n) AS max_n, sum(n) AS sum_n, count(*) AS cnt, string_agg(label, ',') AS labels, array_agg(id) AS ids FROM a WHERE false;

-- name: caseWithoutElse :many
SELECT CASE WHEN n > 10 THEN label END AS maybe_label FROM a;

-- name: nullifTrap :many
SELECT nullif(label, '') AS label_or_null FROM a;

-- name: coalesceSafe :many
SELECT coalesce(b.label, 'none') AS b_label FROM a LEFT JOIN b ON b.a_id = a.id;

-- name: jsonNullLiteral :many
SELECT id, j, j -> 'missing' AS missing FROM weird;

-- name: domainAndEnumArray :many
SELECT id, qty, moods, p, span, total FROM weird;

-- name: selfJoin :many
SELECT parent.label AS parent_label, child.label AS child_label
FROM a child LEFT JOIN a parent ON parent.id = child.n;

-- name: usingJoin :many
SELECT a.id, b.label FROM a LEFT JOIN b USING (id);

-- name: naturalJoinFull :many
SELECT id, label FROM a NATURAL FULL JOIN b;

-- name: windowLag :many
SELECT id, lag(label) OVER (ORDER BY id) AS prev, row_number() OVER () AS rn FROM a;

-- name: filterAggregate :many
SELECT label, count(*) FILTER (WHERE n > 1) AS big, max(n) FILTER (WHERE n > 1000) AS huge FROM a GROUP BY label;

-- name: upsertReturning :one
INSERT INTO a (id, label, n) VALUES (:id, :label, 1)
ON CONFLICT (id) DO UPDATE SET label = excluded.label
RETURNING id, label, n;

-- name: updateFromLeftJoin :many
UPDATE a SET n = a.n + 1 FROM a AS a2 LEFT JOIN b ON b.a_id = a2.id
WHERE a2.id = a.id RETURNING a.id, b.label AS b_label;

-- name: otherSchema :many
SELECT oa.id, oa.note, a.label FROM other.a oa LEFT JOIN a ON a.id = oa.id;

-- name: shadowedSchema :many
SELECT a.id, a.label FROM a LEFT JOIN other.a oa ON oa.id = a.id;

-- name: existsAndNullTest :many
SELECT id, EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id) AS has_b, (label IS NULL) AS no_label FROM a;

-- name: distinctOn :many
SELECT DISTINCT ON (a.id) a.id, b.label FROM a LEFT JOIN b ON b.a_id = a.id ORDER BY a.id, b.id;

-- name: castOfColumn :many
SELECT id::text AS id_text, label::varchar(3) AS short FROM a;

-- name: inListUnion :many
SELECT id, label FROM a WHERE id IN (SELECT id FROM b UNION SELECT id FROM c);

-- name: compositeStar :many
SELECT (p).*, 1 AS one FROM weird;

-- name: groupedExpressions :many
SELECT 1 AS one, coalesce(n, 0) AS c, (label IS NULL) AS no_label, count(*) AS cnt
FROM a GROUP BY ROLLUP (one, c, no_label);

-- name: groupedSubexpression :many
SELECT (label IS NULL)::int AS flag, coalesce(label IS NULL, true) AS safe, count(*) AS cnt
FROM a GROUP BY GROUPING SETS ((label IS NULL), ());

-- name: ungroupedLiteral :many
SELECT 'all' AS scope, label, count(*) AS cnt FROM a GROUP BY CUBE (label);

-- name: mergeNotMatchedBySource :many
MERGE INTO other.a t USING a s ON s.id = t.id
WHEN MATCHED THEN UPDATE SET note = s.label
WHEN NOT MATCHED BY SOURCE THEN UPDATE SET note = t.note
RETURNING t.id, t.note, s.label;

-- name: returningExpressions :many
UPDATE a SET n = n + 1 WHERE id = :id RETURNING id, 'updated' AS action, (label IS NULL) AS no_label, now() AS at;

-- name: expressionsOfColumns :many
SELECT a.n * 2 AS doubled, -a.n AS negated, a.label || '!' AS bang, lower(a.label) AS lowered,
       length(a.label) AS len, (a.n > 1 AND a.id <> 0) AS both_true, NOT (a.n > 1) AS small,
       greatest(b.id, a.id) AS g, a.n IS DISTINCT FROM b.a_id AS differs,
       b.id * 2 AS b_doubled, upper(b.label) AS b_upper, b.a_id::text AS b_a_id, concat(b.label, '') AS c
FROM a LEFT JOIN b ON b.a_id = a.id;

-- name: schemaOverrides :many
SELECT abs(label) AS abs_label, label + n AS plus, n::mood AS m FROM a;

-- name: groupedColumnExpression :many
SELECT n + 0 AS m, count(*) AS cnt FROM a GROUP BY ROLLUP (n);

-- name: selfJoinRight :many
SELECT parent.label AS parent_label, child.label AS child_label FROM a parent RIGHT JOIN a child ON parent.id = child.n;

-- name: rightJoinUsing :many
SELECT id, a.label AS a_label FROM a RIGHT JOIN b USING (id);

-- name: fullUsingNullableColumn :many
SELECT a_id FROM b b1 FULL JOIN b b2 USING (a_id);

-- name: fullUsingSelf :many
SELECT id FROM a a1 FULL JOIN a a2 USING (id);

-- name: mergedBelowOuterJoin :many
SELECT a.id AS a_id, x.id AS x_id FROM a LEFT JOIN (b JOIN c USING (id)) x ON x.id = a.id;

-- name: innerJoinBelowOuterJoin :many
SELECT a.id AS a_id, c.label AS c_label FROM a LEFT JOIN (b JOIN c USING (id)) ON b.id = a.id;

-- name: threePartNames :many
SELECT other.a.id, other.a.note, public.a.label FROM other.a LEFT JOIN public.a ON public.a.id = other.a.id;

-- name: insertThroughRule :one
INSERT INTO redirected (id, label) VALUES (:id, :label) RETURNING id, label;
