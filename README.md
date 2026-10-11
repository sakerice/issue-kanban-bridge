# Issue Kanban Bridge

CodexとClaude Codeが同じローカルIssue Kanbanを使うMITライセンスのプラグインです。利用者ごとに空のボードから始まります。

## できること

- 依頼：ToDo → Plan → InProgress → Review → Done。簡単な依頼はPlanを省略できます。
- ユーザーによるToDoの優先順、承認・差し戻し・キャンセル。番号でIssueを指定できます。キャンセル理由は任意です。
- ReviewにはActivityまたは成果物リンクが必須。Plan以降は担当エージェントと実行場所を記録します。
- Releaseは明示的な指示が必要です。プラグイン自身がGitHub操作や本番反映を実行することはありません。
- 定期実行ログはReview/Releaseを使わず、結果記録後InProgress → Done。Doneは7日後にClosedへ保存され検索できます。
- Claude Codeから依頼本文をToDoへ直接登録。登録だけではエージェントを起動しません。
- Codexのkanban_complete_claudeで結果を保存しDoneへ。元のClaudeセッションの次の入力・再開時に完了報告を取得します。即時通知やセッションの自動起動はありません。
- 登録結果の `watchCommand` をClaude Codeが背景で実行しておくと、Doneになった時点で依頼元セッションが起き、利用者の入力を待たずに結果の確認へ進めます。

## 対応範囲

Node.js 22以上とローカルMCPに対応したCodex/Claude Codeが必要です。MCP Appsの画面表示・会話パネル配置はホストの対応に依存します。ブラウザからの利用も可能です。

この配布候補はローカル版です。クラウド上のYour dotやWeb版から利用者のPCのstdioサーバーへ接続することはできません。同等のクラウド対応には利用者別の認証・保存領域を持つサーバーが別途必要です。既存の個人用クラウドボードへ接続しません。

## ソースから利用

1. このリポジトリを取得します。
2. プラグイン内で依存関係と画面を準備します。

```sh
cd plugins/issue-kanban-bridge
npm ci --ignore-scripts
npm run build
npm test
```

3. Codexではリポジトリをmarketplaceとして登録します。

```sh
codex plugin marketplace add /absolute/path/to/issue-kanban-bridge
```

プラグイン一覧からIssue Kanban Bridgeをインストールし、有効化してください。ホストはインストール時にキャッシュへコピーするため、コピー先に依存関係が無い場合はそのプラグインディレクトリで同じnpm ciとbuildを実行してください。依存関係のダウンロードを自動で実行するhookは含めていません。

GitHubから登録する場合：

```sh
codex plugin marketplace add sakerice/issue-kanban-bridge --ref main
codex plugin add issue-kanban-bridge@issue-kanban-bridge
```

ソース：https://github.com/sakerice/issue-kanban-bridge

「Issue Kanbanを開いて」とCodexへ依頼するとkanban_boardまたはkanban_panelが画面を提供します。ホストのパネル表示は未検証です。

## Claude Codeとの接続

プラグインディレクトリで `node scripts/claude-config.js` を実行すると、その配置場所を使用するMCPとhookの設定案を表示します。設定ファイルを書き換えることはありません。

- `mcpServers`をClaude CodeのMCP設定へ既存項目を保持して追加します。
- `hooks`をClaude Codeのsettings.jsonへ既存hookを保持して追加します。
- PreToolUseが実際のsession_idを登録入力へ設定します。SessionStart/UserPromptSubmitがその元セッションだけの完了報告を取得します。
- CodexとClaudeを同じOSユーザーで実行し、同じ保存先を使用してください。

### 完了を待つ見張り

`issue_kanban_submit` の結果には `watchCommand` が入ります（このPCのNode.jsと `claude/watch.js` の場所、IssueのIDから実行時に組み立てるもので、リポジトリには含まれません）。Claude CodeがBashの背景実行で走らせると、IssueがDone（キャンセル時はClosed）になった時点で1行出して終わり、その終了通知で依頼元セッションが作業を再開します。

- ボードファイルを読むだけで、書き込み・ロック・自動アーカイブはしません。待っている間にモデルは動かないため、トークンを消費しません。
- 既定は60秒ごとに読み、24時間で打ち切ります。`node claude/watch.js <IssueのIDまたは番号> [間隔秒] [上限時間]` で変えられます。
- 終了時の出力は `KANBAN_DONE` / `KANBAN_CLOSED` / `KANBAN_MISSING` / `KANBAN_ERROR` / `KANBAN_TIMEOUT` のいずれかです。
- 見張りはClaude Codeのセッションが開いている間だけ有効です。閉じていた場合は従来どおり、次の入力・再開時にhookが完了報告を渡します。
- `ISSUE_KANBAN_DATA` で保存先を変えている場合は、その指定も `watchCommand` に含まれます。
- Doneはリリース・マージの承認ではありません。

Claudeへの依頼例：「Issue Kanbanへこの依頼を登録して。本文に成果物と完了条件を記録し、再送用sourceIdを固定して。これは登録だけで、エージェントへの依頼送信は別途行う。」

Codexへの依頼例：「#12を対応し、Claude由来ならkanban_complete_claudeで成果物と完了報告を保存して。」

## データと安全性

標準保存先は `~/.local/share/issue-kanban-bridge/board.json` と同ディレクトリのclaude-inboxです。各ユーザーのローカルファイルを使い、外部サーバーへIssueを送る機能はありません。ただしMCPツールの結果・hookの報告本文は利用中のCodex/Claudeの会話へ渡ります。

別のボードに分ける場合は両側の `ISSUE_KANBAN_DATA` に同じ絶対パスを設定します。receiptは元セッションと照合されます。共有PCでは別OSユーザーを使用してください。バックアップ・削除は利用者が保存ディレクトリを管理します。

複数プロセスの更新は排他と版番号で保護します。競合時は最新ボードを読み直して再試行してください。プロセス異常終了で `.lock` が残った場合は、対象ボードの全サーバーが停止したことを確認してからロックだけを削除します。

ブラウザ単独表示は `npm start` でlocalhost:8798を開きます。外部アクセスは推奨しません。認証付きの外部ホスト設定でも利用者別の分離は行われないため、共用サービスとして提供しないでください。

## 公開状態

GitHubでソースを配布します。OpenAIの公開ディレクトリ申請済み・承認済みを意味しません。[公開準備状況](docs/PUBLICATION-READINESS.md)を参照してください。
