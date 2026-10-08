// Raw Claude Code hook payloads -> small typed event set. See docs/hook-events.md.

interface Base { sessionId: string; cwd: string; transcriptPath: string }

export type NormEvent = Base & (
  | { type: 'session_started'; source: string }
  | { type: 'prompt_submitted'; prompt: string }
  | { type: 'tool_finished'; tool: string; file?: string; command?: string; success: boolean; error?: string; edit?: string }
  | { type: 'approval_needed'; message: string }
  | { type: 'turn_finished'; message: string }
  | { type: 'session_ended' }
);

const APPROVAL_TYPES = new Set(['permission_prompt', 'elicitation_dialog']);

export function normalize(raw: any): NormEvent | null {
  if (!raw || typeof raw.session_id !== 'string') return null;
  const base: Base = { sessionId: raw.session_id, cwd: raw.cwd ?? '', transcriptPath: raw.transcript_path ?? '' };
  const input = raw.tool_input ?? {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const tool = (success: boolean) => ({
    ...base,
    type: 'tool_finished' as const,
    tool: String(raw.tool_name ?? ''),
    file: str(input.file_path) ?? str(input.notebook_path),
    command: str(input.command),
    // Text this edit put into the file, so snippets can show the changed region.
    edit: str(input.new_string) ?? str(input.edits?.at?.(-1)?.new_string) ?? str(input.content)?.slice(0, 2000),
    success,
    ...(success ? {} : { error: String(raw.error ?? '') }),
  });

  switch (raw.hook_event_name) {
    case 'SessionStart': return { ...base, type: 'session_started', source: String(raw.source ?? '') };
    case 'UserPromptSubmit': return { ...base, type: 'prompt_submitted', prompt: String(raw.prompt ?? '') };
    case 'PostToolUse': return tool(true);
    case 'PostToolUseFailure': return raw.is_interrupt ? null : tool(false);
    case 'Notification':
      return APPROVAL_TYPES.has(raw.notification_type) ? { ...base, type: 'approval_needed', message: String(raw.message ?? '') } : null;
    case 'Stop': return { ...base, type: 'turn_finished', message: String(raw.last_assistant_message ?? '') };
    case 'SessionEnd': return { ...base, type: 'session_ended' };
    default: return null;
  }
}
