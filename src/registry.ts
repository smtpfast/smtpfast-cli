import { embeddedManifest } from "./manifest.js";
import { readCachedSpec, readMeta, type SpecMeta } from "./refresh.js";
import { buildManifest, ensureUnique } from "./spec/build.js";
import type { GroupSpec, Manifest, OperationSpec } from "./spec/types.js";

export interface LiveState {
  meta: SpecMeta;
  hash: string;
  operationCount: number;
}

/**
 * The commands this run knows: the embedded manifest, plus operations from
 * the cached live spec that this version does not include. The live part is
 * read only when needed, so a normal command does not parse the cached spec.
 */
export class Registry {
  readonly embedded: Manifest;
  private ops: OperationSpec[];
  private groupList: GroupSpec[];
  private extras: OperationSpec[] = [];
  private liveLoaded = false;
  live: LiveState | undefined;

  constructor(
    private readonly configDir: string,
    manifest: Manifest = embeddedManifest(),
  ) {
    this.embedded = manifest;
    this.ops = [...manifest.operations];
    this.groupList = [...manifest.groups];
  }

  /** Merge in operations from the cached live spec. Safe to call more than once. */
  loadLive(): this {
    if (this.liveLoaded) return this;
    this.liveLoaded = true;
    const spec = readCachedSpec(this.configDir);
    if (!spec) return this;
    let manifest: Manifest;
    try {
      manifest = buildManifest(spec).manifest;
    } catch {
      return this;
    }
    this.live = { meta: readMeta(this.configDir), hash: manifest.specHash, operationCount: manifest.operationCount };
    const known = new Set(this.embedded.operations.map((o) => o.operationId));
    const knownRoutes = new Set(this.embedded.operations.map((o) => `${o.method} ${o.path}`));
    const extras = manifest.operations.filter((o) => !known.has(o.operationId) && !knownRoutes.has(`${o.method} ${o.path}`));
    const taken = new Set(this.embedded.operations.map((o) => `${o.group} ${o.command}`));
    ensureUnique(extras, taken);
    this.extras = extras;
    this.ops.push(...extras);
    const groupNames = new Set(this.groupList.map((g) => g.name));
    for (const g of manifest.groups) {
      if (!groupNames.has(g.name) && extras.some((o) => o.group === g.name)) this.groupList.push(g);
    }
    this.groupList.sort((a, b) => (a.name < b.name ? -1 : 1));
    return this;
  }

  /** Operations in the live spec that this version of the CLI was not built with. */
  get newOperations(): OperationSpec[] {
    return this.extras;
  }

  isNew(op: OperationSpec): boolean {
    return this.extras.includes(op);
  }

  get operations(): OperationSpec[] {
    return this.ops;
  }

  get groups(): GroupSpec[] {
    return this.groupList;
  }

  hasGroup(name: string): boolean {
    return this.groupList.some((g) => g.name === name);
  }

  group(name: string): GroupSpec | undefined {
    return this.groupList.find((g) => g.name === name);
  }

  groupOperations(name: string): OperationSpec[] {
    return this.ops.filter((o) => o.group === name).sort((a, b) => (a.command < b.command ? -1 : 1));
  }

  find(group: string, command: string): OperationSpec | undefined {
    return this.ops.find((o) => o.group === group && o.command === command);
  }

  findById(operationId: string): OperationSpec | undefined {
    return this.ops.find((o) => o.operationId === operationId);
  }
}
