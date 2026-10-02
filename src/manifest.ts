import { readFileSync } from "node:fs";
import type { Manifest } from "./spec/types.js";

let injected: Manifest | undefined;
let loaded: Manifest | undefined;

/** The standalone binary bundles the manifest and hands it over here. */
export function setEmbeddedManifest(manifest: Manifest): void {
  injected = manifest;
}

/** The manifest built from the spec snapshot this release shipped with. */
export function embeddedManifest(): Manifest {
  if (injected) return injected;
  if (!loaded) {
    // src/generated in development, dist/generated in the npm package.
    loaded = JSON.parse(readFileSync(new URL("./generated/manifest.json", import.meta.url), "utf8")) as Manifest;
  }
  return loaded;
}
