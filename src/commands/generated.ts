import type { ParseResult } from "../args.js";
import { buildRequest } from "../request.js";
import type { Session } from "../session.js";
import type { OperationSpec } from "../spec/types.js";

/** Run any operation from the manifest: build the request from its parsed flags, print the response. */
export async function runOperation(session: Session, op: OperationSpec, parsed: ParseResult): Promise<number> {
  const req = await buildRequest(op, parsed, { cwd: session.ctx.cwd, stdin: session.ctx.stdin });
  const res = await session.client().request({
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    body: req.body,
    idempotencyKey: session.globals.idempotencyKey,
  });
  session.out.result(res.data, { op });
  return 0;
}
