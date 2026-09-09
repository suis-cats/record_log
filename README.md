# 研究レコーダー

分析を実行せず、後から研究分析に使う原データを記録するWindows用Electronアプリです。

保存するデータは、ActivityWatchのウィンドウ・アプリ・AFKイベント、内容を含まないキー入力・クリック・スクロール・移動時刻、OBS録画、OBS Virtual Camera映像、48 kHzモノラルPCMマイク音声です。動画と音声は10分単位で分割し、同じセッション時間軸の索引を保存します。

## 必要環境

- Windows 10/11 64bit
- Node.js LTS（ソースから実行する場合）
- OBS Studio（OBS WebSocketを有効化）
- ActivityWatch（window/AFK watcherを起動）

## 実行

```powershell
npm install
npm run recorder
```

初回画面で参加者ID、保存先、マイク、OBS WebSocketパスワードを設定して保存します。準備が整うと自動で記録を開始します。

## ポータブルZIP

```powershell
npm run package:portable
```

`release/ResearchRecorder-Windows-x64.zip` が生成されます。展開先の `はじめに.txt` も参照してください。

詳細は [docs/research-recorder.md](docs/research-recorder.md) を参照してください。
