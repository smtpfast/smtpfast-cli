import { parseArgs } from "../args.js";
import { buildRequest, operationFlagDefs } from "../request.js";
import type { Session } from "../session.js";
import type { OperationSpec } from "../spec/types.js";

/** Run any operation from the manifest: parse its flags, build the request, print the response. */
export async function runOperation(session: Session, op: OperationSpec, tokens: string[]): Promise<number> {
  const parsed = parseArgs(tokens, operationFlagDefs(op));
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
