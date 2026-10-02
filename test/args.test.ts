import { describe, expect, test } from "bun:test";
import { type FlagDef, parseArgs } from "../src/args.js";
import { UsageError } from "../src/errors.js";

const defs: FlagDef[] = [
  { name: "subject", kind: "value" },
  { name: "to", kind: "value", multiple: true },
  { name: "active", kind: "boolean" },
  { name: "first-name", aliases: ["first_name"], kind: "value" },
  { name: "quiet", short: "q", kind: "boolean" },
  { name: "limit", kind: "value" },
];

describe("parseArgs", () => {
  test("value flags in both forms, and positionals", () => {
    const r = parseArgs(["abc", "--subject", "Hi there", "--limit=5", "def"], defs);
    expect(r.values).toEqual({ subject: ["Hi there"], limit: ["5"] });
    expect(r.positionals).toEqual(["abc", "def"]);
  });

  test("booleans, negation and explicit values", () => {
    expect(parseArgs(["--active"], defs).values.active).toBe(true);
    expect(parseArgs(["--no-active"], defs).values.active).toBe(false);
    expect(parseArgs(["--active=false"], defs).values.active).toBe(false);
    expect(() => parseArgs(["--active=maybe"], defs)).toThrow(UsageError);
  });

  test("repeatable flags collect values; others refuse repeats", () => {
    expect(parseArgs(["--to", "a@x.com", "--to", "b@x.com"], defs).values.to).toEqual(["a@x.com", "b@x.com"]);
    expect(() => parseArgs(["--subject", "a", "--subject", "b"], defs)).toThrow("more than once");
  });

  test("aliases and short flags", () => {
    expect(parseArgs(["--first_name", "Ann"], defs).values["first-name"]).toEqual(["Ann"]);
    expect(parseArgs(["-q"], defs).values.quiet).toBe(true);
  });

  test("value flags take the next token even when it starts with a dash", () => {
    expect(parseArgs(["--subject", "-", "--limit", "-1"], defs).values).toEqual({ subject: ["-"], limit: ["-1"] });
  });

  test("-- ends flag parsing", () => {
    expect(parseArgs(["--", "--subject", "x"], defs).positionals).toEqual(["--subject", "x"]);
  });

  test("unknown flags suggest the closest one", () => {
    try {
      parseArgs(["--subjct", "x"], defs);
      throw new Error("expected a usage error");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toBe("Unknown flag --subjct");
      expect((err as UsageError).hint).toBe("Did you mean --subject?");
    }
  });

  test("a value flag at the end needs its value", () => {
    expect(() => parseArgs(["--subject"], defs)).toThrow("--subject needs a value");
  });

  test("lenient mode keeps unknown tokens in order", () => {
    const r = parseArgs(["emails", "--json", "list", "--limit", "5", "--quiet", "-x"], [{ name: "json", kind: "boolean" }, { name: "quiet", kind: "boolean" }], { lenient: true });
    expect(r.values).toEqual({ json: true, quiet: true });
    expect(r.rest).toEqual(["emails", "list", "--limit", "5", "-x"]);
  });
});
