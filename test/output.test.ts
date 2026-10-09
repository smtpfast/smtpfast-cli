import { describe, expect, test } from "bun:test";
import { findList } from "../src/output.js";

describe("findList", () => {
  test("reads the list object every list answers with", () => {
    const list = findList({ object: "list", has_more: false, data: [{ id: "dom_1", domain: "acme.test" }] });
    expect(list?.items).toEqual([{ id: "dom_1", domain: "acme.test" }]);
    expect(list?.meta).toEqual({ object: "list", has_more: false });
  });

  test("still reads a bare array, which some lists answered before October 2026", () => {
    expect(findList([{ id: "dom_1" }])?.items).toEqual([{ id: "dom_1" }]);
  });

  test("treats an object with its own id as one object, not a list", () => {
    expect(findList({ id: "dom_1", dns_records: [{ type: "TXT" }] })).toBeUndefined();
  });
});
