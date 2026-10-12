---
name: issue-kanban-bridge
description: Manage user requests and scheduled execution logs on the shared Issue Kanban through its MCP tools. Use for tracked work, progress updates, review decisions, release requests, cancellation, and selecting the next task.
---

## PM役と2つの運用形態

作業の選択・計画・担当割り当て・進行・完了記録を行う役を「PM役」と呼びます。PM役は特定の製品ではなく役割で、kanban_transitionでは `actor: "manager"` として記録します。誰がPM役かは `manager: { environment, name }`（例: `{ "environment": "dot", "name": "Dot" }`、`{ "environment": "local", "name": "Claude Code" }`）で履歴に残せます。従来の `actor: "dot"` も受け付け、managerとして記録します。

- **DotがPM役**: Dotがボードを見てkanban_nextで次の作業を選び、計画・担当割り当て（ローカルCodexなど）・進行を記録します。assigneeには実際に作業するエージェントを書き、Dotは `manager` 側に記録します。このプラグインはローカル版で、同じPC上のstdio/localhostからしか届きません。クラウドで動くDotから使うには、ボードがDotから届く場所にある必要があり、それはこのプラグインの範囲外です。
- **1つのセッションがPM役と作業者を兼ねる**: CodexまたはClaude Codeの1セッションがkanban_nextで1件取り、自分をassignee（environment・name・sourceRef）と `manager` の両方に記録して着手し、作業・kanban_progress・Reviewまで進めます。自分の成果をDoneにはできません。

どちらの形態でも変わらないルール:

- Review → Doneはユーザーの明示的な承認が必要です（evidenceに実際の発言を記録）。PM役が自分で承認しません。
- Releaseはユーザーの明示的な指示が必要です。記録だけでは本番反映しません。
- ToDoの並べ替えはユーザーだけが行います。PM役は独自に優先順を変えません。
- 同じIssueを複数のエージェントで取りません。Plan/InProgress/Releaseのカードはassigneeを確認し、他のエージェントが担当中なら着手しません（このバージョンにはロック機能がありません）。

Use the shared board as the record of the user's requested work. Call `kanban_board` at the start of tracked work. Register a new issue with `kanban_create`; use stable, issue-specific `sourceId` values so retries do not create duplicates. One Activity thread can contain multiple issues. Include real Activity URLs when available; do not fabricate links or report complete Activity coverage without a verified import.

For complex requests, advance ToDo → Plan to discuss the approach and design with the user. Record the proposed plan and consultation in the card history. Remain in Plan while the approach is unresolved; start implementation with Plan → InProgress once the plan is agreed. Plan → ToDo returns the issue to the backlog. Simple requests may advance directly ToDo → InProgress when starting, and InProgress → Review when the requested result is ready for the user. Record substantive chat progress on the same issue with `kanban_progress`, including the source message reference and links to results. If a message reference is unavailable, identify the actual source precisely without inventing a message ID. Do not move an issue simply because the host says an agent run completed.

Review → Done requires explicit user approval of completion. Interpret OK in context: an OK to a comment or proposal does not approve the issue's result. Review → ToDo is a user return for changes; Review → Release is an explicit user request for production release. Record the actual user quote and source with the appropriate intent. If the scope of an OK is unclear, keep the issue in Review and clarify the decision.

For Release, perform the authorized repository and deployment workflow, verify the production result, attach its evidence, and then move Release → Done. Recording Release does not execute deployment. If deployment fails, retain Release and record what failed. Do not treat a merged PR alone as proof of production release.

Select eligible work with `kanban_next`: Release > InProgress > Plan > user ordered ToDo. Do not reorder ToDo independently. Apply priority when selecting the next safe work unit; it does not require interrupting an ongoing unsafe-to-interrupt operation. Review awaits the user. Concurrent agents need coordination before claiming the same issue; check the assignee and do not take an issue another agent is working on. This version does not implement a worker lease.

When the user explicitly cancels an issue, stop its active work using the available host controls, record whether stopping succeeded, and close it with cancellation evidence. Closing the card alone does not stop the underlying agent. Canceling a scheduled execution is distinct from canceling the schedule.

Scheduled-run logs use ToDo/Plan/InProgress → Done → Closed, with no Review or Release. Save the completed execution result with kanban_progress, then move InProgress → Done as the manager (PM role) without requiring user approval. An agent run ending does not prove execution success: record the actual outcome and remaining limitations. Failed/uncompleted runs remain InProgress; cancelled runs use Closed with cancellation evidence. Completed checks finding no new work also go to Done. No review-link requirement applies to this completion, but attach genuine links when available. Existing scheduled Review entries with finished results can move directly to Done. This rule applies only to kind: scheduled-run; ordinary requests still require user review.

Use `kind: scheduled-run` for each execution log, with a source ID containing the schedule and unique run identity. These cards stay outside the request priority queue. Keep the schedule configuration in the host scheduler; this plugin records runs and does not create schedules.

Every mutation uses the current issue version; order changes use the current board revision. On conflict, reload and reconsider against the user's latest instruction before retrying. Done is automatically archived after seven days in that state; Closed retains searchable history and links.

## Claude Codeからの依頼の完了例外

sourceIdがclaude-code:で始まり、registration.sourceSessionIdを持つ登録済みIssueは、完了条件を満たした後kanban_complete_claudeでInProgressまたはReviewから直接Doneにできます。Claude Code側でユーザーがレビューする運用への例外です。完了報告textには成果物・検証結果・残る制限を記載し、sourceRefと成果物linksを保存してください。reportIdは依頼ごとに固定して再試行してください。PM役を記録する場合は `manager` も指定できます。保存されたcompletionは元Claudeセッションの公式hookから取得されます。稼働中か停止中かにかかわらず元セッションの次の入力・再開時に取得し、即時pushやセッションの起動は行いません。通常Issue・セッション不明の旧登録・Plan・ToDo・Closed・Releaseにはこの例外を使えません。Doneはリリース・マージ・本番反映を承認しません。Releaseと本番操作には引き続きユーザーの明示的な指示が必要です。

## カード番号とキャンセル

各カードは永続的なnumber（表示例 #132）と内部UUID idを持ちます。ユーザーが「132をxxして」「#132をキャンセル」と指定したら、kanban_boardのnumberから特定してください。kanban_progress・kanban_transition・kanban_complete_claudeのidにはUUIDまたは番号文字列を指定できます。並べ替え・状態移動で番号は変わりません。取消理由は任意です。理由がなくても実際の「132をキャンセル」「132消して」という明示的な発言をevidence.quoteに記録してClosedへ移せます。「消して」は履歴を保持したキャンセルとして扱い、物理削除しません。実作業の停止は別途確認してください。

## Reviewに入れる前の必須条件

Reviewへ移す前に、カードへ実際のActivityリンク（activityUrl）か成果物・検証結果へのリンク（links）を最低1つ保存してください。両方取得できる場合は両方記載してください。リンクはユーザーが作業内容を開いてレビューできるものに限り、架空URL・ダミーURL・無関係なサイトURLで条件を満たしてはいけません。sourceRefに本文参照やIDを書くだけでは代用できません。既存カードではkanban_progressのlinksにActivityリンクを追記することもできます。定期実行ログはReviewに入れず、結果記録後にDoneへ進めるため、このReview条件の対象外です。バックエンドはリンクがないReview遷移とリンクなしReviewカードの新規取り込みを拒否します。URLのアクセス権やリンク先内容はエージェントが確認して報告してください。リンクを取得できない場合はInProgressに留め、その理由を記録してください。既存のリンク欠落Reviewは画面に要修正表示が出るので、担当者が実際のリンクを補完してください。

## 担当エージェントと実行場所（Plan以降必須）

Plan以降ではassigneeにenvironment（local / codex-cloud / dot / other）、name（実際の担当エージェント名）、sourceRef（担当と実行場所を確認した根拠）を必ず記録します。担当セッションの実URLが分かる場合はsessionUrlも記載します。登録元Claude、PM役（Dotや管理セッション）、作業を実行するエージェントを混同せず、実際の作業担当を記載してください。PM役は `manager` に、作業担当はassigneeに書きます。1セッションが兼ねる場合は両方に自分を記録します。kanban_transitionまたはkanban_progressのassigneeで設定・変更でき、担当交代は履歴に残ります。同じIssueの各フェーズで担当が変わる場合はその都度更新してください。Plan/InProgress/Review/Release/Doneへの新しい遷移は担当未記録を拒否します。元ClaudeへのDone例外にも適用されます。根拠のない自動推定は禁止です。既存データは未確認と表示し、担当者が確認して記録します。
