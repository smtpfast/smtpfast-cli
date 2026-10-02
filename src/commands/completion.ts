import { UsageError } from "../errors.js";
import { operationFlagDefs } from "../request.js";
import { GLOBAL_FLAGS, type Session } from "../session.js";
import { catalog, extensionsFor, findExtension, findTop } from "./catalog.js";
import type { HandCommand } from "./types.js";

const BASH = `# smtpfast completion for bash. Load it in your shell with:
#   source <(smtpfast completion bash)
# or save it once:
#   smtpfast completion bash > ~/.local/share/bash-completion/completions/smtpfast
_smtpfast_complete() {
  local IFS=$'\\n'
  COMPREPLY=($(smtpfast __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _smtpfast_complete smtpfast
`;

const ZSH = `#compdef smtpfast
# smtpfast completion for zsh. Load it in your shell with:
#   source <(smtpfast completion zsh)
# compinit must run first. Or save it as _smtpfast in a directory on your fpath.
_smtpfast() {
  local -a candidates
  candidates=("\${(@f)$(smtpfast __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  if (( \${#candidates} )) && [[ -n "\${candidates[1]}" ]]; then
    compadd -a candidates
  else
    _files
  fi
}
compdef _smtpfast smtpfast
`;

const FISH = `# smtpfast completion for fish. Load it with:
#   smtpfast completion fish | source
# or save it once:
#   smtpfast completion fish > ~/.config/fish/completions/smtpfast.fish
function __smtpfast_complete
    set -l tokens (commandline -opc)
    set -e tokens[1]
    set -l current (commandline -ct)
    smtpfast __complete $tokens "$current" 2>/dev/null
end
complete -c smtpfast -f -a '(__smtpfast_complete)'
`;

export const SCRIPTS: Record<string, string> = { bash: BASH, zsh: ZSH, fish: FISH };

export const completionCommand: HandCommand = {
  name: "completion",
  summary: "Print a shell completion script",
  description:
    "Prints a completion script for bash, zsh or fish. The script asks smtpfast for candidates each time, so new commands complete without reinstalling it.",
  args: [{ name: "bash|zsh|fish", description: "Your shell" }],
  flags: [],
  examples: ["source <(smtpfast completion bash)", "source <(smtpfast completion zsh)", "smtpfast completion fish | source"],
  async run(session, parsed) {
    const shell = parsed.positionals[0];
    if (!shell) throw new UsageError("Missing argument <bash|zsh|fish>");
    const script = SCRIPTS[shell];
    if (!script) throw new UsageError(`Unsupported shell "${shell}"`, "Use bash, zsh or fish.");
    session.out.out(script);
    return 0;
  },
};

const GLOBAL_VALUE_FLAGS = new Set(GLOBAL_FLAGS.filter((f) => f.kind === "value").map((f) => `--${f.name}`));

function flagNames(defs: Array<{ name: string; kind: string; hidden?: boolean }>): string[] {
  return defs.filter((d) => !d.hidden).map((d) => `--${d.name}`);
}

/** Candidates for the last word, given the words typed after "smtpfast". */
export function completeWords(session: Session, words: string[]): string[] {
  const current = words[words.length - 1] ?? "";
  const typed: string[] = [];
  const prior = words.slice(0, -1);
  for (let i = 0; i < prior.length; i++) {
    const w = prior[i]!;
    if (GLOBAL_VALUE_FLAGS.has(w)) {
      i++;
      continue;
    }
    if (!w.startsWith("-")) typed.push(w);
  }
  const registry = session.registry().loadLive();
  const visibleTop = catalog.top.filter((t) => !t.hidden);
  const globalFlags = flagNames(GLOBAL_FLAGS);
  const filter = (list: string[]) => [...new Set(list)].filter((c) => c.startsWith(current)).sort();

  const [first, second] = typed;
  if (current.startsWith("-")) {
    let local: string[] = [];
    const top = first ? findTop(first) : undefined;
    if (top) local = flagNames(top.flags);
    else if (first && second) {
      const ext = findExtension(first, second);
      const op = registry.find(first, second);
      if (ext) local = flagNames(ext.flags);
      else if (op) local = flagNames(operationFlagDefs(op));
    }
    return filter([...local, ...globalFlags]);
  }
  if (!first) return filter([...visibleTop.map((t) => t.name), ...registry.groups.map((g) => g.name)]);
  if (typed.length === 1) {
    if (first === "completion") return filter(Object.keys(SCRIPTS));
    if (first === "profiles") return filter(["list", "use", "remove"]);
    if (first === "help") return filter([...visibleTop.map((t) => t.name), ...registry.groups.map((g) => g.name)]);
    if (first === "api") return filter(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    if (registry.hasGroup(first)) {
      const exts = extensionsFor(first);
      const replaced = new Set(exts.map((e) => e.replaces));
      const ops = registry.groupOperations(first).filter((o) => !replaced.has(o.operationId));
      return filter([...ops.map((o) => o.command), ...exts.map((e) => e.name)]);
    }
    return [];
  }
  if (typed.length === 2 && first === "profiles" && (second === "use" || second === "remove")) {
    try {
      return filter(Object.keys(session.config().profiles));
    } catch {
      return [];
    }
  }
  if (typed.length === 2 && first === "help" && registry.hasGroup(second!)) {
    return filter(registry.groupOperations(second!).map((o) => o.command));
  }
  return [];
}

export function runComplete(session: Session, words: string[]): number {
  try {
    for (const c of completeWords(session, words.length > 0 ? words : [""])) session.ctx.stdout.write(`${c}\n`);
  } catch {
    // Completion must never print errors into the user's prompt.
  }
  return 0;
}
