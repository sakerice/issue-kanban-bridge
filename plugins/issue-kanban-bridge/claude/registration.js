import { BoardStore } from '../src/store.js';
import { dataPath } from '../src/paths.js';
export async function registerReceipt(receipt, inbox) {
  const store = new BoardStore(dataPath);
  const issue = store.register({ ...receipt, sourceId: `claude-code:${receipt.sourceId}` });
  const saved = await inbox.acknowledge(receipt.id, issue.id);
  return { ...saved, status: 'registered', cardStatus: issue.status };
}
export async function readBoard() { return new BoardStore(dataPath).board(); }
