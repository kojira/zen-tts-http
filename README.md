# zen-tts-server

[ZEN-TTS](https://github.com/zenryokukikai/zen-tts) を HTTP で使うための小さなサーバーです。テキストを送ると WAV を返します。

**音声合成：[ZEN-TTS（https://zenryokukikai.com ）](https://zenryokukikai.com)**

## ライセンス

- このリポジトリのコード（`src/`、`scripts/`、`test/`）は MIT です。
- ZEN-TTS 本体とモデルの重みは、全力機械株式会社の [ZEN-TTS ライセンス 1.0](https://github.com/zenryokukikai/zen-tts/blob/main/LICENSE.md) に従います。このリポジトリには含めていません。
  - ZEN-TTS は `package.json` で上流の v1.0.0（`127d26a`）に固定して取り込みます。改変はしません。
  - 重みは `scripts/fetch-models.mjs` が上流から取得し、上流の `models/manifest.json` の sha256 と照合します。再配布はしません。
  - 声を使うアプリや作品では、上のクレジットをリンク付きで表示してください。学習・蒸留・評価への利用は禁止されています。

## 準備

Node.js 26.12.1 以上と pnpm が必要です（`.mise.toml` に固定）。

```sh
pnpm install
pnpm fetch-models            # ./models に約 119 MB を取得して照合（ZEN_TTS_MODELS で場所を変更）
pnpm start                   # 127.0.0.1:50023 で待ち受け
pnpm test
```

環境変数:

| 名前 | 既定値 | 意味 |
|---|---|---|
| `ZEN_TTS_BIND` | `127.0.0.1:50023` | 待ち受けるアドレスとポート |
| `ZEN_TTS_MODELS` | `./models` | 重みを置いたディレクトリ |

声は初めて使うときに読み込みます（1 声あたり約 1.6 秒）。その後は数十ミリ秒で返します。

## API

`GET /health` → `{"ok":true}`

`GET /voices`

```json
{
  "default": "marine",
  "voices": [{ "id": "marine", "name": { "ja": "全力 マリン", "en": "Zenryoku Marine" } }, ...],
  "emotions": ["neutral", "happy", "sad", "angry", "apologetic"]
}
```

`POST /synthesize`（`Content-Type: application/json`）

```json
{ "text": "こんにちは", "voice": "kikka", "emotion": { "happy": 70, "neutral": 30 }, "strength": 1.0 }
```

- `text`：必須。1000 文字まで。
- `voice`：省略すると `marine`。`marine` / `hashiro` / `kai` / `kikka`。
- `emotion`：省略可。各感情の割合（0〜100、比だけが効く）。
- `strength`：省略可。抑揚の強さ（1 が標準）。

成功すると `audio/wav`（44.1 kHz、モノラル、16 bit）を返します。間違いは `{"error": "..."}` で 400、合成の失敗は 500 です。

## macOS で常駐させる（launchd）

`deploy/com.kojira.zen-tts-server.plist` の `YOU` とパスを書き換えて使います。

```sh
cp deploy/com.kojira.zen-tts-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kojira.zen-tts-server.plist
curl http://127.0.0.1:50023/health
```
