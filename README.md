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
| `ZEN_TTS_ADMIN_BIND` | （なし） | もう 1 つ待ち受ける場所（例 `0.0.0.0:50024`）。同じ API と画面を出します。声の読み込みは共有です |
| `ZEN_TTS_MODELS` | `./models` | 重みを置いたディレクトリ |
| `ZEN_TTS_DATA` | （なし） | 追加した声を置くディレクトリ。設定しないと声の追加はできません |

声は初めて使うときに読み込みます（1 声あたり約 1.6 秒）。その後は数十ミリ秒で返します。

## 画面

`GET /` で設定画面を出します（スマホでも読める大きさ、外部ファイルなし）。

- 声の一覧（組み込みと、追加した声）。追加した声は削除できます。
- 試しに読む：文・声・5 つの感情・抑揚の強さを選んで ▶ で再生。
- 声の追加：id・名前と、モデルファイル 4 つを選んで追加。

## 声の追加（カスタム声）

全力機械から受け取った声のモデルファイルを追加できます。上流の ZEN-TTS は改変せず、追加した声は 1 つずつ別のディレクトリに置きます。

```
<ZEN_TTS_DATA>/custom/<id>/
  tts/own.bin  tts/own.json  decoder/nsf.bin  decoder/nsf.json
  voice.json   {"id", "name": {"ja", "en"}, "added_at"}
```

- id は英小文字・数字・ハイフンで 2〜32 文字。組み込みの声（`marine` など）と同じ id は使えません。
- 追加するときに一度読み込んでみて、読み込めないファイルは受け付けません（ファイルは残しません）。
- **モデルファイルはこのリポジトリに含めず、コミットもしません。** 置くのは `ZEN_TTS_DATA` の中だけです。

## API

`GET /health` → `{"ok":true,"version":"1.0.0","models":{"marine":"marine-1.0", ...}}`（ZEN-TTS の版と各 voice のモデル。呼び出し側が音声キャッシュを捨てる判断に使います）

`GET /voices`

```json
{
  "default": "marine",
  "voices": [
    { "id": "marine", "name": { "ja": "全力 マリン", "en": "Zenryoku Marine" }, "custom": false },
    { "id": "my-voice", "name": { "ja": "わたしの声", "en": "My voice" }, "custom": true }
  ],
  "emotions": ["neutral", "happy", "sad", "angry", "apologetic"]
}
```

`POST /voices`（`multipart/form-data`）：`id`、`name_ja`、`name_en`（省略可）と、ファイル `own_bin`・`own_json`・`nsf_bin`・`nsf_json`（各 100 MB まで）。成功すると 201 で `{"voice": {...}}`。読み込めないときは 400、同じ id があるときは 409。

`DELETE /voices/{id}`：追加した声だけ削除できます（組み込みの声は 400）。

`POST /synthesize`（`Content-Type: application/json`）

```json
{ "text": "こんにちは", "voice": "kikka", "emotion": { "happy": 70, "neutral": 30 }, "strength": 1.0 }
```

- `text`：必須。1000 文字まで。
- `voice`：省略すると `marine`。組み込みの `marine` / `hashiro` / `kai` / `kikka` か、追加した声の id。
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
