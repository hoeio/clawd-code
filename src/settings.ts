// Add/remove our hooks in Claude Code's settings.json without touching anything else.

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SessionEnd'];
export const MARKER = 'clawd-companion'; // passed as an arg to hook.sh so we can find our entries again

const isOurs = (h: any) => typeof h?.command === 'string' && h.command.endsWith(` ${MARKER}`);

export function hookCommand(hookPath: string, ...args: string[]): string {
  return [hookPath, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ') + ` ${MARKER}`;
}

/** All sensor hooks are async. The handoff delivery hooks (sync, they must print output) are added only if asked. */
export function addHooks(settings: any, command: string, deliverCommand?: (event: string) => string): any {
  const out = removeHooks(settings);
  out.hooks ??= {};
  for (const ev of HOOK_EVENTS) {
    (out.hooks[ev] ??= []).push({ hooks: [{ type: 'command', command, async: true }] });
  }
  if (deliverCommand) {
    for (const ev of ['UserPromptSubmit', 'Stop']) out.hooks[ev].push({ hooks: [{ type: 'command', command: deliverCommand(ev), timeout: 5 }] });
  }
  return out;
}

export function removeHooks(settings: any): any {
  const out = structuredClone(settings ?? {});
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const ev of Object.keys(out.hooks)) {
    if (!Array.isArray(out.hooks[ev])) continue;
    out.hooks[ev] = out.hooks[ev]
      .map((g: any) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
      .filter((g: any) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
    if (out.hooks[ev].length === 0) delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}
