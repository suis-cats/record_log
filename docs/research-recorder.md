# macOS実機検証手順

1. OBSでWebSocket v5、MKV録画、画面用シーン、実カメラだけのVirtual Camera出力を設定し、ActivityWatchのwindow/AFK watcherを起動する。
2. Research Recorderへカメラ、マイク、Accessibilityを許可し、OBS Virtual Cameraと対象マイクを選ぶ。
3. 設定保存後、すべての系統が「データ保存中」になったことを確認する。権限取得前に記録中にならないことも確認する。
4. 11分以上記録し、途中でウィンドウを閉じる。再表示後も経過時間とファイル増加が継続していることを確認する。
5. ActivityWatchまたは機器を一時切断し、他系統が継続すること、欠落開始・終了と再接続が保存されることを確認する。
6. 「停止して保存」後に再開しないこと、WAV・WebM・MKVが確定することを確認する。
7. ffprobeでWAVが48000Hz、mono、pcm_s16leであること、WebMとMKVが再生可能であること、10分境界前後の時間差を確認する。
8. JSONL、CSV、session.jsonと診断ログにキー内容・キーコード・入力文字列・クリップボードが存在しないことを確認する。
9. プロセス一覧にWhisper、Silero、顔解析、VAD、会話・作業復帰判定がないことを確認する。
10. 強制終了用セッションを作り、次回起動後も残存ファイルが保全され、recovery-*.jsonが作られることを確認する。

OBSまたはActivityWatch本体はResearch Recorder終了後も動作を継続します。OBS接続が切れて所有権を確認できない場合、録画停止を送りません。
