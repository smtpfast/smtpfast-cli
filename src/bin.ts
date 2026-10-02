// Entry point for the standalone binaries built with `bun build --compile`.
// The manifest is bundled into the binary instead of read from disk.
import manifest from "./generated/manifest.json" with { type: "json" };
import { setEmbeddedManifest } from "./manifest.js";
import type { Manifest } from "./spec/types.js";

setEmbeddedManifest(manifest as unknown as Manifest);
await import("./cli.js");
