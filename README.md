# 研究レコーダー for macOS

研究解析に使う生データだけを保存するmacOS専用Electronアプリです。音声認識、顔認識、VAD、会話判定、作業復帰判定などの分析は実行しません。

## 記録内容

- ActivityWatchのウィンドウ・アプリ・AFKイベント
- キー入力時刻と間隔、クリック、スクロール量、マウス移動量、heartbeat
- OBSの通常画面録画（MKV）
- OBS Virtual Cameraのカメラ単独映像（VP8/WebM）
- 選択マイクの48kHz・mono・16bit PCM WAV

操作ログはキー内容、キーコード、入力文字列、修飾キー、クリップボード内容を取得・送信・保存しません。メディアは10分単位で分割し、JSONLは記録中に逐次追記します。

## 必要環境と起動

- Apple Silicon Mac（arm64必須）。Intel版は同梱FFmpegのx64版を別途用意する必要があります。
- OBS Studio。WebSocketサーバーをポート4455で有効にします。
- ActivityWatch。aw-watcher-window と aw-watcher-afk を有効にします。

OBSの録画形式をMKVにします。通常録画には画面を含むシーンを使い、Virtual Cameraでは実カメラだけを含むSceneまたはSourceを選択してください。既存のOBS録画中は開始を待ち、その録画を停止しません。

~~~sh
npm install
npm run recorder
~~~

初回画面で参加者ID、保存先、マイク、OBS Virtual Camera、OBS WebSocketパスワードを設定します。保存先の初期値は ~/Documents/research-recordings です。すべての系統が準備できると自動開始します。

カメラとマイクを許可します。操作ログは「システム設定 → プライバシーとセキュリティ → アクセシビリティ」でResearch Recorderを許可し、アプリを再起動します。OBSの画面収録権限はOBS自身へ付与します。

ウィンドウを閉じても記録は続きます。「停止して保存」はファイルを確定して待機へ戻り、手動で開始するまで再開しません。「終了」は確定後にアプリだけを終了します。

## 保存形式

セッションには audio/*.wav、camera/*.webm、obs/*.mkv、raw/*.jsonl、raw/*.csv、events.jsonl、session.json を保存します。

session.json（schema v2）にはUTC、単調時計、メディア時間、音声サンプル数、codec/container、解像度、分割境界、欠落、再接続、機器と品質を保存します。空き容量10GiB未満では安全停止します。未完了セッションは変更せず、次回起動時に recovery-*.json を追加します。

## パッケージ

~~~sh
npm run package:mac:arm64
~~~

arm64成果物にはarm64のSwiftヘルパーとFFmpegを同梱し、HomebrewやRosettaを必要としません。Developer IDとnotarizationの資格情報は未設定です。配布時は CSC_LINK、CSC_KEY_PASSWORD とAppleのnotarization資格情報を設定して再ビルドしてください。未署名成果物はControlキーを押しながら「開く」で確認できます。

## 検証結果

検証環境: Apple Silicon arm64、macOS 26.5.2、Node.js 26.4.0、OBS 32.1.2。

- 単体テスト12件: 合格
- TypeScriptチェックとViteビルド: 合格
- Swift CGEventTapヘルパー: arm64ビルド合格
- JavaScript構文チェック: 合格
- arm64パッケージ生成・smoke起動: 合格（アプリ本体、Swiftヘルパー、FFmpegがすべてarm64）
- 生成WAVのffprobe確認: pcm_s16le、48000Hz、monoで合格
- Accessibility未許可時のSwiftヘルパー: permission=falseを出力して終了することを確認
- ActivityWatch実機: ローカルAPI接続とwindow/AFK bucketを確認
- OBS実機: 32.1.2の起動と既存画面キャプチャソースを確認。WebSocketサーバーは無効、OBS Camera Extensionは未許可のため録画連携は未検証
- 実マイク、Virtual Camera、OBS録画、10分境界: 権限と機器を使う手動検証が必要
- Intel Mac/x64成果物: x64版FFmpegをこのarm64環境で用意できないため未生成・未検証
- Developer ID署名、notarization: 未検証

生成ZIP: dist/Research Recorder-1.0.0-arm64-mac.zip

手動検証手順は docs/research-recorder.md にあります。

### 計測前テスト

画面上部の「計測前テスト」では、研究セッションを作らずにOBS WebSocketとMKV設定、ActivityWatchのwindow/AFKイベント、Accessibility操作ログ、OBS Virtual Camera映像、選択マイクのレベルと取得品質を確認できる。「すべてテスト」の実行中にキー入力、クリック、スクロール、マウス移動を行い、各欄が緑のチェックになることを確認する。テスト映像・音声・操作イベントは保存されない。「メディアテスト停止」または「記録」タブへ戻るとテスト用ストリームを解放する。

計測前テストではOBS WebSocketへの接続成功と既存録画の有無を合否に使う。現在のOBS形式がMKV以外でも、記録開始時に一時的にMKVへ変更し、正常停止時または開始失敗時に元の形式へ戻すため、接続済みなら警告付き合格と表示する。ActivityWatchが未起動の場合はアプリを起動して最大約12秒再試行する。
