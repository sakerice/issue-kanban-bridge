import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repository is distributed to other developers: no board data, session IDs or paths
// from the machine that produced it. Runtime values (watchCommand, data paths) are built at run time.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const skip = new Set(['.git', 'node_modules']);
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path); else files.push(path);
  }
})(root);

test('distributed files contain no local paths, user names, real session IDs or board data', () => {
  const home = homedir(), user = userInfo().username;
  const found = [];
  for (const file of files) {
    const name = relative(root, file);
    if (/(^|\/)(board(\..+)?\.json|claude-inbox|delivered)(\/|$)|\.receipt\.json$/.test(name)) found.push(`${name}: board data`);
    const text = readFileSync(file, 'utf8');
    if (/\/(Users|home)\/[A-Za-z0-9._-]+\//.test(text)) found.push(`${name}: absolute home path`);
    if (home.length > 1 && text.includes(home)) found.push(`${name}: this machine's home directory`);
    if (user.length > 2 && new RegExp(`\\b${user}\\b`).test(text)) found.push(`${name}: this machine's user name`);
    // Test fixtures use synthetic UUIDs (one repeated digit, e.g. 11111111-1111-4111-…); anything else may be a real ID.
    for (const uuid of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []) {
      if (!/^(.)\1{7}-/.test(uuid)) found.push(`${name}: non-synthetic UUID`);
    }
  }
  assert.deepEqual(found, []);
});
