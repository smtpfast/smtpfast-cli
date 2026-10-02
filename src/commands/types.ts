import type { FlagDef, ParseResult } from "../args.js";
import type { Session } from "../session.js";

/** A command written by hand rather than generated from the spec. */
export interface HandCommand {
  /** The API group it sits in, like "domains" for domains verify. Undefined for top-level commands. */
  group?: string;
  name: string;
  summary: string;
  description?: string;
  args?: Array<{ name: string; description: string; optional?: boolean }>;
  flags: FlagDef[];
  examples: string[];
  /** operationId of the generated command this one takes the place of. */
  replaces?: string;
  hidden?: boolean;
  run(session: Session, parsed: ParseResult): Promise<number>;
}
