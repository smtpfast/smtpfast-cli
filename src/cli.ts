#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`smtpfast: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
