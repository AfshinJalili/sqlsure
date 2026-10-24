// What node-postgres (`pg`, default type parsers) returns for each Postgres type, and what it accepts
// as a parameter. Every row of this table is checked against a real Postgres by the eval harness.

export type TypeRepr =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "Date" }
  | { kind: "Buffer" }
  | { kind: "json" }
  | { kind: "unknown" }
  | { kind: "point" }
  | { kind: "circle" }
  | { kind: "interval" }
  | { kind: "literal"; values: string[] }
  | { kind: "array"; element: TypeRepr; elementNullable: true }
  /** Parameter-only unions such as `number | string | bigint`. */
  | { kind: "union"; members: TypeRepr[] }
  | { kind: "bigint" }
  | { kind: "jsonObject" };

const S: TypeRepr = { kind: "string" };
const N: TypeRepr = { kind: "number" };
const B: TypeRepr = { kind: "boolean" };
const D: TypeRepr = { kind: "Date" };
const BUF: TypeRepr = { kind: "Buffer" };
const J: TypeRepr = { kind: "json" };
const arr = (element: TypeRepr): TypeRepr => ({ kind: "array", element, elementNullable: true });

/** Output types: oid -> what `pg` hands back with its default parsers. */
const OUTPUT: Record<number, TypeRepr> = {
  16: B, // bool
  17: BUF, // bytea
  18: S, // char
  19: S, // name
  20: S, // int8 (pg returns strings to avoid precision loss)
  21: N, // int2
  23: N, // int4
  25: S, // text
  26: N, // oid
  114: J, // json
  142: S, // xml
  600: { kind: "point" },
  650: S, // cidr
  700: N, // float4
  701: N, // float8
  718: { kind: "circle" },
  774: S, // macaddr8
  790: S, // money
  829: S, // macaddr
  869: S, // inet
  1042: S, // bpchar
  1043: S, // varchar
  1082: D, // date
  1083: S, // time
  1114: D, // timestamp
  1184: D, // timestamptz
  1186: { kind: "interval" },
  1266: S, // timetz
  1560: S, // bit
  1562: S, // varbit
  1700: S, // numeric
  2950: S, // uuid
  3614: S, // tsvector
  3802: J, // jsonb
  // Arrays with a pg parser.
  1000: arr(B),
  1001: arr(BUF),
  1005: arr(N),
  1007: arr(N),
  1009: arr(S),
  1014: arr(S),
  1015: arr(S),
  1016: arr(S),
  1021: arr(N),
  1022: arr(N),
  1028: arr(N), // oid[]
  1115: arr(D),
  1182: arr(D),
  1183: arr(S),
  1185: arr(D),
  1187: arr({ kind: "interval" }),
  1231: arr(S),
  1270: arr(S),
  199: arr(J),
  2951: arr(S),
  3807: arr(J),
  1041: arr(S), // inet[]
  651: arr(S), // cidr[]
  1040: arr(S), // macaddr[]
  791: arr(S), // money[]
  1017: arr({ kind: "point" }),
};

/** Deliberate type-table bugs for the harness' mutation tests. Empty in normal use. */
export const typeMutations = new Set<string>();

export function outputType(oid: number, enums: Map<number, string[]>): TypeRepr {
  if (typeMutations.has("int8-as-number") && oid === 20) return N;
  if (typeMutations.has("numeric-as-number") && oid === 1700) return N;
  if (typeMutations.has("date-as-string") && (oid === 1082 || oid === 1184 || oid === 1114)) return S;
  if (typeMutations.has("non-null-array-elements") && OUTPUT[oid]?.kind === "array") return { ...(OUTPUT[oid] as any), elementNullable: true, nonNullElements: true };
  const known = OUTPUT[oid];
  if (known) return known;
  const labels = enums.get(oid);
  if (labels) return { kind: "literal", values: labels };
  // pg returns the raw text for every type it has no parser for: enum arrays, composites, ranges,
  // domains, extension types.
  return S;
}

/** Parameter types: what `pg` serializes correctly for each oid. */
export function paramType(oid: number, enums: Map<number, string[]>): TypeRepr {
  switch (oid) {
    case 16:
      return B;
    case 17:
      return BUF;
    case 20:
      return { kind: "union", members: [N, S, { kind: "bigint" }] };
    case 21:
    case 23:
    case 26:
    case 700:
    case 701:
      return N;
    case 1700:
      return { kind: "union", members: [N, S] };
    case 1082:
    case 1114:
    case 1184:
      return { kind: "union", members: [D, S] };
    case 114:
    case 3802:
      // pg JSON-stringifies plain objects but turns JS arrays into Postgres arrays, so a JSON array
      // must be passed pre-stringified.
      return { kind: "union", members: [{ kind: "jsonObject" }, S] };
  }
  const out = OUTPUT[oid];
  if (out?.kind === "array") {
    const el = paramType(elementOid(oid) ?? 0, enums);
    return { kind: "array", element: el, elementNullable: true };
  }
  const labels = enums.get(oid);
  if (labels) return { kind: "literal", values: labels };
  if (out) return out.kind === "point" || out.kind === "circle" || out.kind === "interval" ? S : out;
  return S;
}

const ELEMENT: Record<number, number> = {
  1000: 16, 1001: 17, 1005: 21, 1007: 23, 1009: 25, 1014: 1042, 1015: 1043, 1016: 20, 1021: 700,
  1022: 701, 1028: 26, 1115: 1114, 1182: 1082, 1183: 1083, 1185: 1184, 1187: 1186, 1231: 1700,
  1270: 1266, 199: 114, 2951: 2950, 3807: 3802, 1041: 869, 651: 650, 1040: 829, 791: 790, 1017: 600,
};

export function elementOid(arrayOid: number): number | undefined {
  return ELEMENT[arrayOid];
}

export function render(t: TypeRepr): string {
  switch (t.kind) {
    case "string":
    case "number":
    case "boolean":
    case "unknown":
    case "bigint":
      return t.kind;
    case "Date":
      return "Date";
    case "Buffer":
      return "Buffer";
    case "json":
      return "Json";
    case "jsonObject":
      return "{ [key: string]: Json }";
    case "point":
      return "{ x: number; y: number }";
    case "circle":
      return "{ x: number; y: number; radius: number }";
    case "interval":
      return "Interval";
    case "literal":
      return t.values.length ? t.values.map((v) => JSON.stringify(v)).join(" | ") : "never";
    case "array": {
      const el = render(t.element);
      return `(${el} | null)[]`;
    }
    case "union":
      return t.members.map(render).join(" | ");
  }
}

/** Runtime check used by the soundness oracle: does `value` belong to the type? */
export function conforms(t: TypeRepr, value: unknown): boolean {
  switch (t.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "bigint":
      return typeof value === "bigint";
    case "Date":
      return value instanceof Date;
    case "Buffer":
      return Buffer.isBuffer(value);
    case "unknown":
      return true;
    case "json":
      return isJson(value);
    case "jsonObject":
      return typeof value === "object" && value !== null && !Array.isArray(value) && isJson(value);
    case "point":
      return isObj(value) && typeof value.x === "number" && typeof value.y === "number";
    case "circle":
      return isObj(value) && typeof value.x === "number" && typeof value.y === "number" && typeof value.radius === "number";
    case "interval":
      return isObj(value) && Object.values(value).every((v) => typeof v === "number" || typeof v === "function");
    case "literal":
      return typeof value === "string" && t.values.includes(value);
    case "array":
      return Array.isArray(value) && value.every((v) => (v === null ? !(t as { nonNullElements?: boolean }).nonNullElements : conforms(t.element, v)));
    case "union":
      return t.members.some((m) => conforms(m, value));
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isJson(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  if (isObj(v)) return Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every(isJson);
  return false;
}
