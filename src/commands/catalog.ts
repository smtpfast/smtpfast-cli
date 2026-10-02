import type { HandCommand } from "./types.js";

/** Hand-written commands, filled in by commands/index.ts. Kept separate to avoid import cycles. */
export const catalog: { top: HandCommand[]; extensions: HandCommand[] } = { top: [], extensions: [] };

export function extensionsFor(group: string): HandCommand[] {
  return catalog.extensions.filter((e) => e.group === group);
}

export function findTop(name: string): HandCommand | undefined {
  return catalog.top.find((t) => t.name === name);
}

export function findExtension(group: string, name: string): HandCommand | undefined {
  return catalog.extensions.find((e) => e.group === group && e.name === name);
}
