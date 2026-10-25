import { expect, test } from "vitest";
import { getUser } from "./users.sql";

test("users.sql loads under Vitest, with its parameters rewritten", () => {
  expect(getUser.paramNames).toEqual(["id"]);
  expect(getUser.sql).toContain("$1");
});
