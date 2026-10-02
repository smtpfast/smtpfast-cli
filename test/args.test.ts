import { describe, expect, test } from "bun:test";
import { type FlagDef, parseArgs, parseWithGlobals, splitCommandLine } from "../src/args.js";
import { CliError, UsageError } from "../src/errors.js";
import { catalog } from "../src/commands/index.js";
import { GLOBAL_FLAGS } from "../src/session.js";
import { RESERVED_FLAGS } from "../src/spec/build.js";

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

  test("a value flag takes a token that looks like a flag", () => {
    expect(parseArgs(["--subject", "--help", "--to", "-q"], defs).values).toEqual({ subject: ["--help"], to: ["-q"] });
  });
});

describe("splitCommandLine", () => {
  const words = (first: string) => (first === "help" ? Infinity : first === "send" ? 1 : 2);
  const split = (argv: string[]) => splitCommandLine(argv, GLOBAL_FLAGS, words);

  test("global flags before and between the command words are set aside with their values", () => {
    expect(split(["--profile", "staging", "emails", "--json", "list", "--limit", "5"])).toEqual({
      words: ["emails", "list"],
      globalTokens: ["--profile", "staging", "--json"],
      rest: ["--limit", "5"],
    });
    expect(split(["-q", "--base-url=http://x", "send", "--subject", "--help"])).toEqual({
      words: ["send"],
      globalTokens: ["-q", "--base-url=http://x"],
      rest: ["--subject", "--help"],
    });
  });

  test("everything after the command words is left for the command", () => {
    expect(split(["emails", "list", "--json", "--no-debug"]).rest).toEqual(["--json", "--no-debug"]);
    expect(split(["send", "extra"]).rest).toEqual(["extra"]);
  });

  test("an unknown flag ends the command words", () => {
    expect(split(["emails", "--limit", "5", "list"])).toEqual({ words: ["emails"], globalTokens: [], rest: ["--limit", "5", "list"] });
    expect(split(["--limit", "5"])).toEqual({ words: [], globalTokens: [], rest: ["--limit", "5"] });
  });

  test("help takes every word", () => {
    expect(split(["help", "emails", "--json", "list"]).words).toEqual(["help", "emails", "list"]);
  });

  test("-- ends flags: the next tokens finish the command, the rest stay positional", () => {
    expect(split(["--", "emails", "get", "--odd"])).toEqual({ words: ["emails", "get"], globalTokens: [], rest: ["--", "--odd"] });
    expect(split(["emails", "get", "--", "--odd"]).rest).toEqual(["--", "--odd"]);
  });
});

describe("parseWithGlobals", () => {
  const local: FlagDef[] = [
    { name: "subject", kind: "value" },
    { name: "wait", kind: "boolean" },
  ];

  test("splits local and global values, with correct arity for both", () => {
    const r = parseWithGlobals(["id1", "--subject", "--help", "--json", "--profile", "--wait", "--no-wait"], local, GLOBAL_FLAGS);
    expect(r.local).toEqual({ values: { subject: ["--help"], wait: false }, positionals: ["id1"] });
    expect(r.global).toEqual({ json: true, profile: ["--wait"] });
  });

  test("--no- forms of global booleans stay global", () => {
    expect(parseWithGlobals(["--no-debug", "--no-json"], local, GLOBAL_FLAGS).global).toEqual({ debug: false, json: false });
  });

  test("-- makes the rest positional", () => {
    expect(parseWithGlobals(["--", "--help"], local, GLOBAL_FLAGS)).toEqual({ local: { values: {}, positionals: ["--help"] }, global: {} });
  });

  test("a command flag that shadows a global flag is an error; such an alias is dropped", () => {
    for (const bad of [
      { name: "json", kind: "value" },
      { name: "no-debug", kind: "value" },
      { name: "color", kind: "boolean" },
      { name: "x", short: "q", kind: "boolean" },
    ] as FlagDef[]) {
      expect(() => parseWithGlobals([], [bad], GLOBAL_FLAGS)).toThrow(CliError);
    }
    const r = parseWithGlobals(["--no-json"], [{ name: "first", aliases: ["no-json", "json"], kind: "value" }], GLOBAL_FLAGS);
    expect(r.global).toEqual({ json: false });
  });

  test("no hand-written command flag clashes with a global flag", () => {
    for (const cmd of [...catalog.top, ...catalog.extensions]) expect(() => parseWithGlobals([], cmd.flags, GLOBAL_FLAGS)).not.toThrow();
  });

  test("RESERVED_FLAGS covers every global flag and the --no- form of each global boolean", () => {
    for (const g of GLOBAL_FLAGS) {
      expect(RESERVED_FLAGS.has(g.name)).toBe(true);
      if (g.kind === "boolean") expect(RESERVED_FLAGS.has(`no-${g.name}`)).toBe(true);
    }
  });
});
