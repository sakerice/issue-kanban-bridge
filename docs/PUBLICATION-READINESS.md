# 公開準備状況

## Git配布候補

名称 Issue Kanban Bridge、リポジトリ名候補 issue-kanban-bridge、バージョン0.1.0、MIT。
ソースは許可したファイルだけを別ディレクトリへコピーしました。個人のIssue、スレッド履歴、クラウド設定、認証情報、Gitの既存履歴は配布対象に含めません。
ローカルMCP、Claude登録、元セッションへの次回入力時の結果取得、定期実行Doneの実装を含みます。隔離したClaude登録MCP・Codex MCP・session hookの実プロセス往復を含む16件の自動テストが成功しました。検査済みZIPは32ファイルで、個人識別子・Site接続情報・秘密鍵形式のスキャンも通過しました。実際のClaudeアプリやCodexのホスト内インストール/UI確認は未実施です。

GitHub配布先は sakerice/issue-kanban-bridge です。この新規リポジトリにはこの配布用ソースだけをpushします。個人用リポジトリやその履歴をpublicへ変更しません。OpenAIディレクトリのverified publisherは未設定です。

## OpenAIの公開ディレクトリ

このローカルGit配布候補はディレクトリ提出用の完成ZIPではありません。現在の個人用Siteとそのプラグインをpublicへ変更してはいけません。

別途必要な準備：公開者の本人/組織確認、公開Website/Support/Privacy/Termsの4URL、アイコンPNG、実録デモと公開閲覧URL、実接続による審査ケース、提供国・決済の有無の確認、必要な安全性確認と本人による申告。

クラウド版を一般利用者へ提供する場合は、認証・利用者ごとの保存領域・削除手段・ホスティングを実装し、その実際のデータ運用をプライバシー説明へ反映する必要があります。ローカル版を個人用Siteの共通データベースへ繋ぐ方法は使いません。

公式仕様：https://developers.openai.com/plugins/build/plugins
