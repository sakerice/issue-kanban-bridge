import { hasReviewLink } from '../src/workflow.js';
import { App } from '@modelcontextprotocol/ext-apps';

const root = document.querySelector('#app');
const embedded = window.parent !== window;
const app = embedded ? new App({ name: 'Issue Kanban', version: '0.2.1' }, { availableDisplayModes: ['fullscreen'] }) : null;
let board, selected, query = '', busy = false, error = '', dragged;
let draftTitle = '';
let reflectionNotice = '';
const reflectionRequest = `Issue Kanbanへ、このスレッド内のユーザーの依頼と進捗を反映してください。まずkanban_guideとkanban_boardで運用ルールと既存カードを確認してください。
未登録の依頼は、元の依頼を識別できる安定したsourceIdでToDoへ登録してください。同じ依頼のカードがある場合は新規作成せず、実際の進捗・成果物リンクを既存カードへ追記してください。同じ進捗の二重記録を避け、実際に確認できる作業状態だけを反映してください。
取得できる場合は、このスレッドのActivityリンクをカードに付けてください。完了承認・本番反映の指示・キャンセルは、ユーザーの明示的な発言を確認できた場合のみ記録してください。
この依頼はカンバンへの記録・整理です。未着手の作業や本番反映を新たに開始せず、反映したカードと反映できなかった事項を報告してください。`;
async function requestReflection() {
  if (busy) return;
  busy = true; error = ''; reflectionNotice = ''; render();
  try {
    if (app) {
      const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: reflectionRequest }], _meta: { 'openai/message': { target: 'active', send: true } } });
      if (result?.isError) throw new Error('反映依頼を送信できませんでした。');
      reflectionNotice = 'このスレッドへ反映依頼を送信しました。反映完了はチャットの報告とカードで確認できます。';
    } else {
      await navigator.clipboard.writeText(reflectionRequest);
      reflectionNotice = '反映依頼文をコピーしました。反映したいPM役（Dotまたは作業セッション）のチャットへ貼り付けて送信してください。';
    }
  } catch (e) { error = e.message || '反映依頼を送信できませんでした。'; }
  finally { busy = false; render(); }
}
const decisionDrafts = new Map();
const statuses = ['ToDo', 'Plan', 'InProgress', 'Review', 'Release', 'Done'];
const colors = { ToDo: '#8798a6', Plan: '#d692be', InProgress: '#47b0df', Review: '#d8b968', Release: '#ba95fa', Done: '#7ac5a3' };
const labels = { ToDo: '着手待ち', Plan: '段取り・設計を相談中', InProgress: '作業中', Review: 'あなたの確認待ち', Release: '本番反映待ち', Done: '完了 · 7日間保持' };
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
function button(text, fn, cls = '') { const b = el('button', text, cls); b.type = 'button'; b.disabled = busy; b.onclick = fn; return b; }
function time(at) { return new Date(at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function safeLink(url, label) {
  let parsed;
  try { parsed = new URL(url); } catch { return el('span', label || url); }
  if (!['http:', 'https:', 'codex:'].includes(parsed.protocol)) return el('span', label || url);
  const a = el('a', label || url); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  if (app) a.onclick = async event => { event.preventDefault(); try { await app.openLink({ url }); } catch (e) { error = e.message; render(); } };
  return a;
}
async function call(name, args = {}, silent = false) {
  if (busy && !silent) return;
  if (!silent) { busy = true; error = ''; render(); }
  try {
    let result;
    if (app) {
      result = await app.callServerTool({ name, arguments: args });
      if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '更新できませんでした');
      result = result.structuredContent;
    } else {
      const response = await fetch('/api/tool', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }) });
      result = await response.json(); if (!response.ok) throw new Error(result.error);
    }
    if (result?.board) { board = result.board; if (name === 'kanban_create') { draftTitle = ''; } }
  } catch (e) { error = e.message; }
  finally { if (!silent) busy = false; render(); }
}
function decide(issue, to, intent, quote) {
  return call('kanban_transition', { id: issue.id, expectedVersion: issue.version, to, actor: 'user', evidence: { intent, sourceRef: `ui:${crypto.randomUUID()}`, quote } });
}
function swap(issue, direction) {
  const ids = [...board.todoOrder]; const at = ids.indexOf(issue.id); const target = at + direction;
  if (target < 0 || target >= ids.length) return;
  [ids[at], ids[target]] = [ids[target], ids[at]];
  return call('kanban_reorder_todo', { ids, expectedRevision: board.revision });
}
function ordered(kind, status) {
  const issues = board.issues.filter(i => i.kind === kind && i.status === status);
  if (status === 'ToDo' && kind === 'request') return issues.sort((a, b) => board.todoOrder.indexOf(a.id) - board.todoOrder.indexOf(b.id));
  return issues.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
const agentPlaces = { local: 'ローカル', 'codex-cloud': 'Codex Cloud', dot: 'Dot', other: 'その他' };
function agentLabel(issue) { return issue.assignee ? `${agentPlaces[issue.assignee.environment] || '不明'} · ${issue.assignee.name}` : '担当・実行場所：未確認'; }
function card(issue, compact = false) {
  const node = el('article', undefined, compact ? 'card small' : 'card');
  node.append(button(`#${issue.number} ${issue.title}`, () => { selected = issue.id; render(); }, 'card-title'));
  if (issue.status === 'Review' && !hasReviewLink(issue)) node.append(el('p', '要修正：レビュー用リンクがありません', 'error'));
  if (issue.status !== 'ToDo') node.append(el('p', agentLabel(issue), 'hint'));
  const last = [...issue.history].reverse().find(h => h.type === 'progress');
  if (last && !compact) node.append(el('p', last.text, 'summary'));
  const meta = el('div', undefined, 'meta'); meta.append(el('span', time(issue.updatedAt)));
  if (issue.activityUrl) meta.append(safeLink(issue.activityUrl, 'Activity ↗'));
  node.append(meta);
  if (issue.status === 'ToDo' && issue.kind === 'request') {
    const actions = el('div', undefined, 'order'); actions.append(el('span', `優先 ${board.todoOrder.indexOf(issue.id) + 1}`), button('↑', () => swap(issue, -1)), button('↓', () => swap(issue, 1))); node.append(actions);
    node.draggable = !busy;
    node.ondragstart = () => { dragged = issue.id; };
    node.ondragover = e => e.preventDefault();
    node.ondrop = e => { e.preventDefault(); if (!dragged || dragged === issue.id) return; const ids = board.todoOrder.filter(id => id !== dragged); ids.splice(ids.indexOf(issue.id), 0, dragged); dragged = null; void call('kanban_reorder_todo', { ids, expectedRevision: board.revision }); };
  }
  return node;
}
function lanes(kind, compact) {
  const lanes = el('div', undefined, compact ? 'lanes mini' : 'lanes');
  for (const status of (compact ? statuses.filter(s => !['Review', 'Release'].includes(s)) : statuses)) {
    const column = el('section', undefined, 'column'); column.style.setProperty('--accent', colors[status]);
    const issues = ordered(kind, status);
    const heading = el('div', undefined, 'column-head'); heading.append(el('strong', status), el('span', String(issues.length), 'count')); column.append(heading);
    if (!compact) column.append(el('p', labels[status], 'hint'));
    issues.forEach(issue => column.append(card(issue, compact)));
    if (!issues.length) column.append(el('div', '—', 'empty'));
    lanes.append(column);
  }
  return lanes;
}
function detail(issue) {
  const backdrop = el('div', undefined, 'backdrop');
  const dialog = el('section', undefined, 'detail'); dialog.role = 'dialog'; dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', issue.title); dialog.tabIndex = -1;
  const close = button('閉じる ×', () => { selected = null; render(); }, 'close');
  dialog.append(close, el('div', `${issue.status} · ${issue.kind === 'request' ? '依頼' : '定期実行ログ'}`, 'eyebrow'), el('h2', `#${issue.number} ${issue.title}`));
  dialog.append(el('p', agentLabel(issue), 'sync'));
  if (issue.assignee?.sessionUrl) dialog.append(safeLink(issue.assignee.sessionUrl, '担当セッションを開く ↗'));
  if (issue.activityUrl) dialog.append(safeLink(issue.activityUrl, 'Activityスレッドを開く ↗'));
  else dialog.append(el('p', 'Activityリンクは未登録です', 'hint'));
  if (issue.status === 'Review' && !hasReviewLink(issue)) dialog.append(el('p', 'Activityリンクまたは成果物リンクの追加が必要です。担当チャットへ追加を依頼してください。', 'error'));
  const actions = el('div', undefined, 'actions');
  if (issue.status === 'Review') actions.append(button('承認してDoneへ', () => decide(issue, 'Done', 'approve', 'このIssueの成果を承認し、Doneへ移動する')), button('本番反映を依頼', () => decide(issue, 'Release', 'release', 'このIssueをReleaseへ移動し、本番反映を依頼する')));
  const reflection = el('div', undefined, 'reflection');
  reflection.append(button(app ? 'このスレッドをカンバンへ反映' : '反映依頼文をコピー', requestReflection), el('span', app ? '反映したいチャットの横パネルで押してください。このチャットへ依頼を送信します。' : 'コピーした依頼文を対象のチャットへ送信します。', 'hint'));
  root.append(reflection);
  if (reflectionNotice) { const notice = el('p', reflectionNotice, 'sync'); notice.role = 'status'; root.append(notice); }
  if (error) { const alert = el('p', error, 'error'); alert.role = 'alert'; dialog.append(alert); }
  const form = el('form', undefined, 'decision-form'); form.onsubmit = event => event.preventDefault(); const reason = el('input'); reason.placeholder = '差し戻し理由／キャンセル理由（任意）'; reason.setAttribute('aria-label', reason.placeholder); reason.value = decisionDrafts.get(issue.id) || ''; reason.oninput = () => decisionDrafts.set(issue.id, reason.value); form.append(reason);
  if (issue.status === 'Review') form.append(button('差し戻してToDoへ', () => { if (!reason.value.trim()) { reason.focus(); return; } void decide(issue, 'ToDo', 'return', `差し戻し: ${reason.value}`); }));
  if (!['Done', 'Closed'].includes(issue.status)) form.append(button('キャンセル', () => { void decide(issue, 'Closed', 'cancel', `#${issue.number}をキャンセル${reason.value.trim() ? `: ${reason.value.trim()}` : ''}`); }, 'danger'));
  if (issue.status === 'Release') dialog.append(el('p', 'PM役による本番反映と結果確認を待っています。', 'hint'));
  if (!['Done', 'Closed'].includes(issue.status)) dialog.append(actions, form);
  if (issue.closedReason) dialog.append(el('p', issue.closedReason === 'cancelled' ? 'キャンセル済み · 実作業の停止結果は履歴で確認してください' : 'Doneから7日経過でアーカイブ', 'hint'));
  dialog.append(el('h3', '成果物・リンク'));
  if (!issue.links.length) dialog.append(el('p', 'まだありません', 'hint'));
  for (const link of issue.links) dialog.append(safeLink(link.url, link.label));
  dialog.append(el('h3', '作業と判断の履歴'));
  for (const event of [...issue.history].reverse()) {
    const entry = el('div', undefined, 'event'); entry.append(el('time', time(event.at)));
    entry.append(el('p', event.type === 'progress' ? event.text : event.type === 'created' ? '依頼を受領 → ToDo' : event.type === 'assignment' ? `担当変更: ${event.from ? `${agentPlaces[event.from.environment]} · ${event.from.name}` : '未確認'} → ${agentPlaces[event.to.environment]} · ${event.to.name}` : `${event.from} → ${event.to}${event.manager ? `（PM: ${agentPlaces[event.manager.environment] || '不明'} · ${event.manager.name}）` : ''}`));
    if (event.evidence) entry.append(el('blockquote', event.evidence.quote), el('small', event.evidence.sourceRef));
    if (event.sourceRef) entry.append(el('small', event.sourceRef));
    if (event.releaseResult) entry.append(el('small', `本番反映確認: ${event.releaseResult.sourceRef}`));
    for (const link of event.links || []) entry.append(safeLink(link.url, link.label));
    dialog.append(entry);
  }
  backdrop.append(dialog); backdrop.onclick = e => { if (e.target === backdrop) { selected = null; render(); } };
  dialog.onkeydown = e => {
    if (e.key === 'Escape') { selected = null; render(); }
    if (e.key === 'Tab') { const nodes = [...dialog.querySelectorAll('button:not(:disabled),input,a[href]')]; const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  };
  queueMicrotask(() => dialog.focus());
  return backdrop;
}
function render() {
  root.replaceChildren();
  const header = el('header'); header.append(el('div', 'SHARED WORKSPACE', 'eyebrow'), el('h1', 'Issue Kanban'), el('p', '依頼から確認、本番反映まで。同じボードで進める。', 'subtitle'));
  const tools = el('div', undefined, 'toolbar'); tools.append(el('span', '作業優先順  Release › InProgress › Plan › ToDo', 'priority'), button(busy ? '更新中…' : '更新', () => call('kanban_board', { query }))); header.append(tools); root.append(header);
  const reflection = el('div', undefined, 'reflection');
  reflection.append(button(app ? 'このスレッドをカンバンへ反映' : '反映依頼文をコピー', requestReflection), el('span', app ? '反映したいチャットの横パネルで押してください。このチャットへ依頼を送信します。' : 'コピーした依頼文を対象のチャットへ送信します。', 'hint'));
  root.append(reflection);
  if (reflectionNotice) { const notice = el('p', reflectionNotice, 'sync'); notice.role = 'status'; root.append(notice); }
  if (error) { const alert = el('p', error, 'error'); alert.role = 'alert'; root.append(alert); }
  if (!board) { root.append(el('p', 'ボードへ接続しています…')); return; }
  root.append(el('p', board.sync?.cloud ? 'カードは共有保存されます。PM役の報告時に進捗を記録する運用です。' : 'ローカル確認用 · PM役（Dotまたは作業セッション）の接続は別途必要です', 'sync'));
  if (board.sync?.cloud) {
    const backups = el('div', undefined, 'toolbar');
    if (app) {
      backups.append(button('データを書き出す', async () => {
        busy = true; error = ''; render();
        try {
          const result = await app.callServerTool({ name: 'kanban_board', arguments: {} });
          if (result.isError) throw new Error('データの取得に失敗しました');
          const snapshot = result.structuredContent?.board;
          if (!snapshot) throw new Error('書き出すデータを取得できませんでした');
          const { schemaVersion, revision, issues, todoOrder } = snapshot;
          const download = await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: 'file:///issue-kanban-backup.json', mimeType: 'application/json', text: JSON.stringify({ schemaVersion, revision, issues, todoOrder }, null, 2) } }] });
          if (download.isError) throw new Error('書き出しがキャンセルされたか、アプリで許可されませんでした');
        } catch (e) { error = e.message; } finally { busy = false; render(); }
      }));
    } else {
      const exportLink = el('a', 'データを書き出す'); exportLink.href = '/api/export'; exportLink.download = 'issue-kanban-backup.json'; backups.append(exportLink);
    }
    backups.append(el('span', '全カード・履歴・優先順をJSONで保存', 'hint'));
    if (!app) {
    const input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; input.setAttribute('aria-label', '既存カードのデータを取り込む');
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      busy = true; error = ''; render();
      try {
        const response = await fetch('/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text() });
        const result = await response.json(); if (!response.ok) throw new Error(result.error); board = result.board;
      } catch (e) { error = e.message; } finally { busy = false; render(); }
    };
    backups.append(input);
    }
    root.append(backups);
  }
  const form = el('form', undefined, 'create'); const title = el('input'); title.placeholder = '新しい依頼'; title.required = true; title.setAttribute('aria-label', '新しい依頼のタイトル'); title.value = draftTitle; title.oninput = () => { draftTitle = title.value; };
  const add = button('ToDoに追加', () => form.requestSubmit()); form.append(title, add);
  form.onsubmit = e => { e.preventDefault(); if (!title.value.trim()) return; void call('kanban_create', { title: title.value, kind: 'request', sourceId: `ui:${crypto.randomUUID()}` }); }; root.append(form);
  root.append(lanes('request', false));
  const scheduled = el('section', undefined, 'scheduled'); scheduled.append(el('h2', '定期実行ログ'), el('p', '実行ごとの結果と履歴 · 完了した実行はDoneへ', 'hint'), lanes('scheduled-run', true)); root.append(scheduled);
  const archive = el('section', undefined, 'archive'); const top = el('div', undefined, 'archive-head'); top.append(el('h2', `Closed · ${board.issues.filter(i => i.status === 'Closed').length}`));
  const search = el('input'); search.type = 'search'; search.placeholder = '番号・タイトル・履歴・リンクを検索'; search.value = query; search.setAttribute('aria-label', 'Closedを検索');
  const searchForm = el('form'); searchForm.append(search, button('検索', () => searchForm.requestSubmit())); searchForm.onsubmit = e => { e.preventDefault(); query = search.value; void call('kanban_board', { query }); }; top.append(searchForm); archive.append(top);
  for (const issue of board.closed) { const row = el('div', undefined, 'archive-row'); row.append(el('span', agentLabel(issue), 'hint'), button(`#${issue.number} ${issue.title}`, () => { selected = issue.id; render(); }, 'card-title'), el('span', time(issue.updatedAt)), el('span', issue.closedReason === 'cancelled' ? 'キャンセル' : '完了')); archive.append(row); }
  if (!board.closed.length) archive.append(el('p', '該当するClosedはありません', 'hint')); root.append(archive);
  if (selected) { const issue = board.issues.find(i => i.id === selected); if (issue) root.append(detail(issue)); }
}
if (app) {
  app.ontoolresult = result => { if (result.structuredContent?.board) { board = result.structuredContent.board; render(); } };
  try {
    await app.connect();
    const context = app.getHostContext();
    if (context?.displayMode !== 'fullscreen' && context?.availableDisplayModes?.includes('fullscreen')) {
      await app.requestDisplayMode({ mode: 'fullscreen' });
    }
    // The host delivers the opener's result to ontoolresult after initialization.
    // Do not invoke the opener again and create another app view on launch.
  } catch (e) { error = e.message; render(); }
} else await call('kanban_board');
setInterval(() => { if (!busy && !selected && !document.hidden && !document.querySelector('input:focus')) void call('kanban_board', { query }, true); }, 15000);
