# zen-tts-server

[ZEN-TTS](https://github.com/zenryokukikai/zen-tts) を HTTP で使うための小さなサーバーです。テキストを送ると WAV を返します。

**音声合成：[ZEN-TTS（https://zenryokukikai.com ）](https://zenryokukikai.com)**

## ライセンス

- このリポジトリのコード（`src/`、`scripts/`、`test/`）は MIT です。
- ZEN-TTS は全力機械株式会社の [ZEN-TTS ライセンス 1.0](https://github.com/zenryokukikai/zen-tts/blob/main/LICENSE.md) に従います。対象は、上流リポジトリのソースコードと文書、モデルの重み（上流リポジトリの G2P `models/g2p/` と、全力機械が ZEN-TTS 用に配布する voice のモデルファイル `.ztm`）です。このリポジトリにはどれも含めていません。
  - ZEN-TTS は `package.json` で上流の 1.1.0（`ee0af07`。v1.1.0 タグの次のコミットで、ライセンス 1 章の対象を 1.1.0 の配り方に合わせたもの）に固定して取り込みます。改変はしません。G2P はこのパッケージに入っています。
  - voice の `.ztm` は `scripts/fetch-models.mjs` が全力機械の CDN（`https://tts-models.zenryoku.work/v1.1.0/`）から取得し、上流 README の表にある sha256 と照合します。再配布はしません。
  - 声を使うアプリや作品では、上のクレジットをリンク付きで表示してください。改変・再配布、学習・蒸留・評価への利用は禁止されています。

## 準備

Node.js 26.12.1 以上と pnpm が必要です（`.mise.toml` に固定）。

```sh
pnpm install
pnpm fetch-models            # ./models に 4 声の .ztm（各 26 MB）を取得して照合（ZEN_TTS_MODELS で場所を変更）
pnpm start                   # 127.0.0.1:50023 で待ち受け
pnpm test
```

環境変数:

| 名前 | 既定値 | 意味 |
|---|---|---|
| `ZEN_TTS_BIND` | `127.0.0.1:50023` | 待ち受けるアドレスとポート |
| `ZEN_TTS_ADMIN_BIND` | （なし） | もう 1 つ待ち受ける場所（例 `0.0.0.0:50024`）。同じ API と画面を出します。声の読み込みは共有です |
| `ZEN_TTS_MODELS` | `./models` | 組み込みの声の `.ztm` と `voices.json` を置いたディレクトリ（`pnpm fetch-models` が作ります） |
| `ZEN_TTS_DATA` | （なし） | 追加した声を置くディレクトリ。設定しないと声の追加はできません |
| `ZEN_TTS_WORKERS` | `1` | 合成をするプロセス（ワーカー）の数。`auto` は使えるコアの数です（下の「同時にたくさん合成する」） |

声は初めて使うときに読み込みます（1 声あたり約 1.6 秒）。その後は数十ミリ秒で返します。

### 同時にたくさん合成する（`ZEN_TTS_WORKERS`）

合成は、HTTP を受けるプロセスとは別の、合成用のプロセス（ワーカー）で動きます。1 つのワーカーは、1 つのコアで 1 本ずつ合成します。`ZEN_TTS_WORKERS` の数だけワーカーを起動し、依頼は届いた順に、空いているワーカーに渡します。その声を読み込み済みのワーカーがあれば、そちらを先に使います。

- 返す音声は、ワーカーの数によらず同じです（ZEN-TTS を直接呼んだときと同じ WAV のバイト列）。API も同じです。
- 既定の `1` では、同時に合成できるのは 1 本で、ほかの依頼は順番を待ちます。ワーカーの数は、使えるコアの数（`auto`）までにします。それより多くしても速くなりません。`auto` は、コンテナの CPU の割り当て（`docker --cpus`）に従います。
- 声は、ワーカーごとに、初めて使うときに読み込みます。メモリは、ワーカー 1 つ・声 1 つあたり約 110〜150 MB です。
- 追加した声は、追加したときに 1 つのワーカーで読み込んで確かめます。ほかのワーカーは、初めて使うときに `ZEN_TTS_DATA` から読み込みます。削除すると、すべてのワーカーから消えます。
- ワーカーが落ちたときは、そのとき合成していた依頼だけ 500 を返し、新しいワーカーを起動して続けます。

前の版は、HTTP を受けるプロセスの中で合成していました。そのため、混んでいるときは、HTTP の処理も合成が終わるまで止まり、待っている接続（keep-alive）がサーバー側で閉じられて、依頼が接続の切断（ECONNRESET）で失敗することがありました（同時 40 本で 200 本中 8 本ほど）。この版では、HTTP を受けるプロセスは合成をしないので、混んでいても `/health` などはすぐに返り、切断も起きません。

測った値（マリン、1 文 約 3.6 秒の音声を、同時にたくさん頼み続けたとき。「秒/秒」は 1 秒あたりに作れた音声の秒数）：

| 機械 | `ZEN_TTS_WORKERS` | 同時 | 作れた量 | 1 本の待ち時間（中央／95%） | メモリ |
|---|---|---|---|---|---|
| Linux、Xeon Silver 4316、`docker --cpus 4`、native（AVX-512） | 1 ※ | 32 | 21.9 秒/秒 | 4.7 秒／9.5 秒 | 0.19 GB |
| 同上 | 4 | 32 | 87.6 秒/秒 | 1.3 秒／1.4 秒 | 0.84 GB |
| 同上、`--cpus 8` | 8 | 32 | 172.3 秒/秒 | 0.66 秒／0.70 秒 | 1.5 GB |
| 同上、`--cpus 4`、wasm | 4 | 32 | 36.1 秒/秒 | 3.1 秒／3.2 秒 | 0.81 GB |
| 同上、`--cpus 8`、wasm | 8 | 32 | 70.3 秒/秒 | 1.6 秒／1.7 秒 | 1.5 GB |
| MacBook Pro（M3 Max、16 コア、ほかの作業で混んでいるとき）、wasm | 1 | 16 | 18.3 秒/秒 | 3.1 秒／3.3 秒 | 0.39 GB |
| 同上 | 4 | 16 | 43.2 秒/秒 | 1.3 秒／1.5 秒 | － |
| 同上 | 8 | 16 | 45.2 秒/秒 | 1.2 秒／1.6 秒 | 2.0 GB |

※ 前の版（HTTP のプロセスの中で合成）で測った値です。

- 1 本だけ頼むときの速さは、ワーカーの数で変わりません（native 約 0.17 秒、wasm 約 0.2〜0.4 秒）。
- Mac の 8 ワーカーが 4 ワーカーとほぼ同じなのは、測ったときに、ほかの作業がコアを使っていたためです。

## 画面

`GET /` で設定画面を出します（スマホでも読める大きさ、外部ファイルなし）。

- 声の一覧（組み込みと、追加した声）。追加した声は削除できます。
- 試しに読む：文・声・5 つの感情・抑揚の強さを選んで ▶ で再生。辞書（JSON）も入れられます（項目の配列か、ZEN-TTS のデモで書き出した形）。
- 声の追加：id・名前と、モデルファイル（`.ztm`）を選んで追加。1.0.0 の形（ファイル 4 つ）も切り替えで追加できます。

## 声の追加（カスタム声）

全力機械から受け取った声のモデルファイルを追加できます。上流の ZEN-TTS は改変せず、追加した声は 1 つずつ別のディレクトリに置きます。

```
<ZEN_TTS_DATA>/custom/<id>/
  voice.ztm                                                   1.1.0 の形（ふつうはこちら）
  tts/own.bin  tts/own.json  decoder/nsf.bin  decoder/nsf.json  1.0.0 の形（古い声）
  voice.json   {"id", "name": {"ja", "en"}, "added_at", "format"}
```

- 1.1.0 の声は `.ztm` 1 ファイル（100 MB まで）。1.0.0 の 4 ファイルの声も、そのまま追加・利用できます。

- id は英小文字・数字・ハイフンで 2〜32 文字。組み込みの声（`marine` など）と同じ id は使えません。
- 追加するときに一度読み込んでみて、読み込めないファイルは受け付けません（ファイルは残しません）。
- **モデルファイルはこのリポジトリに含めず、コミットもしません。** 置くのは `ZEN_TTS_DATA` の中だけです。

## API

`GET /health` → `{"ok":true,"version":"1.1.0","models":{"marine":"marine-1.0", ...}}`（ZEN-TTS の版と各 voice のモデル。呼び出し側が音声キャッシュを捨てる判断に使います）

`GET /voices`

```json
{
  "default": "marine",
  "voices": [
    { "id": "marine", "name": { "ja": "全力 マリン", "en": "Zenryoku Marine" }, "custom": false },
    { "id": "my-voice", "name": { "ja": "わたしの声", "en": "My voice" }, "custom": true }
  ],
  "emotions": ["neutral", "happy", "sad", "angry", "apologetic"],
  "speed": { "min": 0.5, "max": 1.5 }
}
```

`POST /voices`（`multipart/form-data`）：`id`、`name_ja`、`name_en`（省略可）と、ファイル `ztm`（`.ztm`、100 MB まで）。1.0.0 の声は `ztm` の代わりに `own_bin`・`own_json`・`nsf_bin`・`nsf_json`（各 100 MB まで）。成功すると 201 で `{"voice": {...}}`。読み込めないときは 400、同じ id があるときは 409。

`DELETE /voices/{id}`：追加した声だけ削除できます（組み込みの声は 400）。

`POST /synthesize`（`Content-Type: application/json`）

```json
{ "text": "こんにちは", "voice": "kikka", "emotion": { "happy": 70, "neutral": 30 }, "strength": 1.0, "speed": 1.2 }
```

- `text`：必須。1000 文字まで。
- `voice`：省略すると `marine`。組み込みの `marine` / `hashiro` / `kai` / `kikka` か、追加した声の id。
- `emotion`：省略可。各感情の割合（0〜100、比だけが効く）。
- `strength`：省略可。抑揚の強さ（1 が標準）。
- `speed`：省略可。話す速さの倍率（1 が標準）。受け付ける範囲は入っている ZEN-TTS が決め、`GET /voices` の `speed`（`{"min","max"}`）で分かります。範囲の外は 400 です。速さを変えられない ZEN-TTS（1.1.0 など）では `speed` は `null` で、1 以外は 400 です。
- `dict`：省略可。ユーザー辞書（2000 項目まで）。形は ZEN-TTS の README「辞書の形式」と同じです：`surface`（書き方、必須、64 文字まで）、`reading`（カタカナかひらがな、必須、128 文字まで）、`accent`（0 以上の整数）、`phrase`（`"split"` か `"join"`）、`strength`（0 以上）、`contour`（拍ごと、-3〜3）、`pitch`（拍ごと、半音）、`length`（拍ごと、0 より大きい倍率）。読み・アクセント・イントネーションが変わります。
- `settings`：省略可。辞書の全体の設定 `{ "accentHeight": 4.5 }`（アクセント型のある語の高い拍の高さ、半音）。

```json
{ "text": "明日は晴れ", "dict": [{ "surface": "明日", "reading": "アス", "accent": 2 }] }
```

成功すると `audio/wav`（44.1 kHz、モノラル、16 bit）を返します。間違いは `{"error": "..."}` で 400、合成の失敗は 500 です。

`POST /analyze`（`Content-Type: application/json`）：1 語を、モデルがどう読むか（読み・拍・アクセント型）を返します。辞書の項目を、数字を打たずに作るためのものです。

```json
{ "text": "明日", "voice": "marine", "dict": [] }
```

- `text`：必須。64 文字まで（辞書の `surface` と同じ）。
- `voice`・`dict`：`/synthesize` と同じ。`dict` を渡すと、その辞書を当てた読みを返します。

```json
{ "reading": "アシタ", "moras": ["ア", "シ", "タ"], "accent": 3 }
```

`accent` はアクセント型です：0 = 平板、n = n 拍目の後で下がる。語は「〇〇は。」の形で読みます（文の中と同じ読みになり、尾高の下がりも出ます）。読めないときは 400。

## macOS で常駐させる（launchd）

`deploy/com.kojira.zen-tts-server.plist` の `YOU` とパスを書き換えて使います。

```sh
cp deploy/com.kojira.zen-tts-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.kojira.zen-tts-server.plist
curl http://127.0.0.1:50023/health
```
