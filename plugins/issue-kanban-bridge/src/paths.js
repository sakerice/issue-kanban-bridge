import { homedir } from 'node:os';
import { join } from 'node:path';
export const dataPath = process.env.ISSUE_KANBAN_DATA || process.env.DOTS_KANBAN_DATA || join(homedir(), '.local', 'share', 'issue-kanban-bridge', 'board.json');

// ISSUE_KANBAN_* are canonical; DOTS_KANBAN_* remain as fallbacks for existing installations.
export function httpConfig(env = process.env) {
  const token = env.ISSUE_KANBAN_TOKEN || env.DOTS_KANBAN_TOKEN || '';
  const host = env.ISSUE_KANBAN_HOST || env.DOTS_KANBAN_HOST || '127.0.0.1';
  const port = Number(env.PORT || 8798);
  if (host !== '127.0.0.1' && !token) throw new Error('Remote access requires ISSUE_KANBAN_TOKEN');
  return { token, host, port };
}
