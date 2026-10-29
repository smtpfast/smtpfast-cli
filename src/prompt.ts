import type { Context, InStream } from "./context.js";

/**
 * Lines from stdin, one at a time, for prompts and for values an agent pipes
 * in. One reader per stream, so a run with several prompts never loses what
 * arrived early, and the stream is paused between lines so the process can
 * exit once the command is done.
 */
class LineReader {
  private buffer = "";
  private ended = false;
  private wake: (() => void) | null = null;
  private attached = false;

  constructor(private readonly stream: InStream) {}

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.stream.setEncoding?.("utf8");
    this.stream.on("data", (chunk: string | Buffer) => {
      this.buffer += chunk.toString();
      this.wake?.();
    });
    const done = () => {
      this.ended = true;
      this.wake?.();
    };
    this.stream.on("end", done);
    this.stream.on("error", done);
  }

  async line(): Promise<string | null> {
    this.attach();
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, "");
        this.buffer = this.buffer.slice(at + 1);
        this.stream.pause();
        return line;
      }
      if (this.ended) {
        const rest = this.buffer;
        this.buffer = "";
        return rest ? rest : null;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.stream.resume();
      });
      this.wake = null;
    }
  }
}

const readers = new WeakMap<InStream, LineReader>();

/** The next line of stdin, or null at the end of it. */
export function readLine(ctx: Pick<Context, "stdin">): Promise<string | null> {
  let reader = readers.get(ctx.stdin);
  if (!reader) {
    reader = new LineReader(ctx.stdin);
    readers.set(ctx.stdin, reader);
  }
  return reader.line();
}

/** Ask on stderr and read the answer, trimmed. Null when stdin has ended. */
export async function prompt(ctx: Pick<Context, "stdin" | "stderr">, question: string): Promise<string | null> {
  ctx.stderr.write(question);
  const answer = await readLine(ctx);
  return answer === null ? null : answer.trim();
}

/** A yes or no question. Enter takes the default. */
export async function confirm(ctx: Pick<Context, "stdin" | "stderr">, question: string, byDefault = true): Promise<boolean> {
  const answer = await prompt(ctx, `${question} ${byDefault ? "[Y/n]" : "[y/N]"} `);
  if (answer === null || answer === "") return byDefault;
  return /^y(es)?$/i.test(answer);
}

/** Whether a person can answer prompts. Same rule as login: stdin is a terminal. */
export function interactive(ctx: Pick<Context, "stdin">): boolean {
  return Boolean(ctx.stdin.isTTY);
}
