import { homedir } from 'node:os';
import { join } from 'node:path';
export const dataPath = process.env.ISSUE_KANBAN_DATA || process.env.DOTS_KANBAN_DATA || join(homedir(), '.local', 'share', 'issue-kanban-bridge', 'board.json');
