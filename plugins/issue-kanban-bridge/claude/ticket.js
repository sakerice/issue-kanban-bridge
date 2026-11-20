// One-time confirmation that the Issue Kanban PreToolUse hook checked a submit call.
// The hook writes a ticket bound to the real session ID and the exact request contents;
// the inbox MCP server redeems (deletes) it before accepting a request that names a
// sourceSessionId. A call that skipped the hook, or whose contents differ from what the
// hook saw, has no ticket and is refused. Tickets live next to the receipts (mode 0700/0600).
import { mkdir, readFile, readdir, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ticketMaxAgeMs = 10 * 60 * 1000;
const ticketDirectory = directory => join(directory, 'tickets');
export function ticketKey(sessionId, input) {
  const fields = [sessionId, input.title, input.description, input.sourceId, input.projectPath ?? null, input.sourceUrl ?? null];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
export async function issueTicket(directory, sessionId, input, now = Date.now()) {
  const folder = ticketDirectory(directory);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = join(folder, `.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ sessionId, createdAt: new Date(now).toISOString() }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(folder, `${ticketKey(sessionId, input)}.json`));
  // Also tidy here, so tickets never pile up while an older inbox server does not redeem them.
  await removeExpired(folder, now);
}
export async function redeemTicket(directory, sessionId, input, now = Date.now()) {
  const folder = ticketDirectory(directory);
  const file = join(folder, `${ticketKey(sessionId, input)}.json`);
  let ticket;
  try { ticket = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  // Delete first so a ticket can never be used twice, even if registration later fails.
  try { await unlink(file); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await removeExpired(folder, now);
  const age = now - Date.parse(ticket.createdAt);
  return ticket.sessionId === sessionId && age >= 0 && age <= ticketMaxAgeMs;
}
async function removeExpired(folder, now) {
  let names;
  try { names = await readdir(folder); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
    const file = join(folder, name);
    try { if (now - (await stat(file)).mtimeMs > ticketMaxAgeMs) await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
