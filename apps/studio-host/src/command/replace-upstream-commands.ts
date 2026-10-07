import type { CommandDef } from '@/upstream/commands';

/** Replaces known upstream commands and fails loudly if an override target disappears. */
export function replaceUpstreamCommands(
  upstreamCommands: readonly CommandDef[],
  replacements: readonly CommandDef[],
): CommandDef[] {
  const replacementById = new Map(replacements.map((command) => [command.id, command]));
  if (replacementById.size !== replacements.length) {
    throw new Error('Duplicate HOP command override target');
  }
  const result = upstreamCommands.map((command) => {
    const replacement = replacementById.get(command.id);
    replacementById.delete(command.id);
    return replacement ?? command;
  });
  if (replacementById.size > 0) {
    throw new Error(`Missing upstream command override targets: ${[...replacementById.keys()].join(', ')}`);
  }
  return result;
}

export function assertUniqueCommandIds(commandGroups: readonly (readonly CommandDef[])[]): void {
  const ids = new Set<string>();
  for (const commands of commandGroups) {
    for (const command of commands) {
      if (ids.has(command.id)) throw new Error(`Duplicate command contribution: ${command.id}`);
      ids.add(command.id);
    }
  }
}
