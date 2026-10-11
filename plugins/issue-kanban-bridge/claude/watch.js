// Waits until a registered issue is finished, prints one line and exits.
//
//   node claude/watch.js <issueId> [intervalSeconds=60] [maxHours=24]
//
// Completion reports reach the originating Claude session only on its next input/resume.
// Claude Code can run this command as a background task right after issue_kanban_submit:
// the task ending wakes the session, so it can review the result without waiting for the user.
// Read-only: it parses the board file directly and never archives, locks or writes.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataPath } from '../src/paths.js';

export function readBoardFile(path = dataPath) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { issues: [] };
}

export async function watch(id, options = {}) {
  const every = (options.every ?? 60) * 1000;
  const now = options.now || Date.now;
  const until = now() + (options.hours ?? 24) * 3600e3;
  const read = options.readBoard || (() => readBoardFile(options.path));
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let fails = 0;
  for (;;) {
    try {
      const issue = (await read()).issues.find(i => i.id === id || String(i.number) === id);
      fails = 0;
      if (!issue) return { result: 'KANBAN_MISSING', id };
      if (issue.status === 'Done') return { result: 'KANBAN_DONE', id: issue.id, title: issue.title };
      if (issue.status === 'Closed') return { result: 'KANBAN_CLOSED', id: issue.id, title: issue.title };
    } catch (error) {
      // A read can race a writer's rename; retry, and give up after 6 consecutive failures.
      if (++fails >= 6) return { result: 'KANBAN_ERROR', id, message: error.message };
    }
    if (now() > until) return { result: 'KANBAN_TIMEOUT', id };
    await sleep(every);
  }
}

export function watchCommand(issueId) {
  const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  // A custom board location must reach the background process too; the default needs no prefix.
  const custom = process.env.ISSUE_KANBAN_DATA || process.env.DOTS_KANBAN_DATA;
  return `${custom ? `ISSUE_KANBAN_DATA=${quote(dataPath)} ` : ''}${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} ${quote(issueId)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, every, hours] = process.argv.slice(2);
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id || '')) { console.error('Usage: node claude/watch.js <issueId|number> [intervalSeconds] [maxHours]'); process.exit(2); }
  const r = await watch(id, { every: every ? Number(every) : undefined, hours: hours ? Number(hours) : undefined });
  console.log([r.result, r.id, r.title || r.message || ''].join(' ').trim());
  process.exit(r.result === 'KANBAN_DONE' ? 0 : 1);
}
