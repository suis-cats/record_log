# 研究レコーダー

`Start-Research-Recorder.cmd` は、分析を行わず研究用の原データだけを記録する独立アプリを起動する。既存の Conversation Return Lab と同時には使用しない。

## 記録内容

- `obs/`: OBSの現在シーンをMKVで記録する。アプリが開始した録画だけを停止する。
- `camera/`: OBS Virtual Cameraを720p・30fpsでWebMに記録する。
- `audio/`: 選択マイクを48kHz・mono・16bit PCM WAVに記録する。
- `raw/`: ActivityWatchと、キーの内容を含まない入力操作時刻をJSONL/CSVで記録する。
- `session.json`: 全ファイルのUTC区間、メディア時間、取得形式、完了状態をまとめる。
- `events.jsonl`: 接続、分割、欠落、時計変更を追記する。

各メディアは10分ごとに分割する。停止時に会話検出、顔解析、Silero、Whisper、作業復帰分析は実行しない。ウィンドウを閉じてもトレイで記録は続く。

## 起動条件

OBSとActivityWatchを先に起動する。OBS WebSocketのパスワードは初回だけ画面で入力する。別のOBS録画が動いている場合は停止せず待機する。OBS Virtual Cameraはアプリが必要に応じて開始する。

既定の保存先は `F:\research-recordings`。空き容量が10 GiB未満になると保存可能なファイルを確定して停止する。
