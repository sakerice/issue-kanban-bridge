import { mkdir, readFile, readdir, writeFile, link, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { dataPath } from '../src/paths.js';
import { createHash, randomUUID } from 'node:crypto';

export const defaultDirectory = join(dirname(dataPath), 'claude-inbox');
export class Inbox {
  constructor(directory = defaultDirectory) { this.directory = directory; }
  path(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid receipt ID');
    return join(this.directory, `${id}.json`);
  }
  async submit({ title, description, sourceId, projectPath, sourceUrl, sourceSessionId }) {
    if (!title?.trim() || title.length > 300 || !description?.trim() || description.length > 20000 || !sourceId?.trim() || sourceId.length > 500) throw new Error('Invalid request');
    if (sourceSessionId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sourceSessionId)) throw new Error('Invalid Claude session ID');
    if (projectPath && !projectPath.startsWith('/')) throw new Error('projectPath must be absolute');
    if (sourceUrl && !['https:', 'http:', 'codex:'].includes(new URL(sourceUrl).protocol)) throw new Error('Invalid source URL');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = createHash('sha256').update(sourceId).digest('hex');
    const payload = { title: title.trim(), description: description.trim(), sourceId, projectPath: projectPath || null, sourceUrl: sourceUrl || null, ...(sourceSessionId ? { sourceSessionId } : {}) };
    const file = this.path(id);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const receipt = { id, ...payload, status: 'queued', submittedAt: new Date().toISOString(), issueId: null, error: null };
    await writeFile(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
    try { await link(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await unlink(temporary); }
    const saved = await this.get(id);
    for (const key of Object.keys(payload)) if (saved[key] !== payload[key]) throw new Error('sourceId already used for different contents; use a new sourceId');
    return saved;
  }
  async get(id) { return JSON.parse(await readFile(this.path(id), 'utf8')); }
  async pending() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const receipts = await Promise.all(files.map(name => this.get(name.slice(0, -5))));
    return receipts.filter(item => item.status !== 'imported').sort((a,b) => a.submittedAt.localeCompare(b.submittedAt));
  }
  async acknowledge(id, issueId) {
    if (!issueId?.trim()) throw new Error('Issue ID required');
    const receipt = await this.get(id);
    if (receipt.status === 'imported' && receipt.issueId !== issueId) throw new Error('Receipt already linked to another issue');
    const updated = { ...receipt, status: 'imported', issueId, importedAt: receipt.importedAt || new Date().toISOString(), error: null };
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, this.path(id));
    return updated;
  }
}
