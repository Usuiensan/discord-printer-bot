# Discord レシートプリンタ bot 使い方

指定チャンネルに投稿すると、Epson TM-T70II 58mm レシートプリンタへ印刷されます。

管理者向けのセットアップ、起動、権限設定は [ADMIN.md](ADMIN.md) を参照してください。

## 基本

普通にメッセージを投稿すると、その本文が印刷されます。

- URL は本文として印字されます。QRコードが欲しい場合は `!qr` または `!print-code qr` を使います
- 添付画像、スタンプ、絵文字は画像として印字されます。標準設定では絵文字画像は本文中の位置に挿入されます
- 添付テキストファイルは中身が本文として印字されます
- 印刷完了後、bot がリアクションを付けます
- 紙切れやプリンタエラー時は bot がエラーを返します

バッククォートやコードブロックの囲み記号は印字されません。中身は通常メッセージと同じように扱われるため、URL検出や `!print-code` も動きます。Discordの自動リンク化を避けたい時に使えます。

````text
```
!print-code qr https://example.com
!img 1
**太字にならない**
```
````

## プレビュー

印刷せずに確認したい場合は、投稿の先頭に `!preview` を付けます。Discord に `preview.png` が返信されます。

```text
!preview
!center
領収書
!row 小計 | ¥500
!row 外税 | ¥40
!bold on
!size 2 1
!row 合計 | ¥540
```

## 画像

添付画像は通常、本文などの後にまとめて印刷されます。途中に挿入したい場合は `!img` を使います。

```text
上の文章
!img 1
下の文章
```

サイズ指定もできます。紙幅に対する割合です。

```text
!img 1 50%
!img 2 25
```

画像ファイル名のラベルを印字しない場合:

```text
!img-notext 1 50%
```

絵文字は管理者設定 `EMOJI_RENDER_MODE=inline_image` の場合、書いた位置で改行して絵文字画像を挿入します。従来のように本文中は `:emoji_name:` として印字し、画像を末尾にまとめたい場合は管理者に `EMOJI_RENDER_MODE=alias_append` を設定してもらってください。

`.txt`、`.md`、`.csv`、`.json`、`.log` などのテキスト添付は、添付本文として印字されます。UTF-8を優先し、読めない場合はShift_JIS系として読みます。

## バーコード・QRコード

プリンタ内蔵機能でコードを印字できます。

```text
!qr https://example.com
!print-code qr https://example.com
!print-code code128 ABC123
!print-code jan13 490123456789
```

通常のURL投稿はURL文字列として印字されます。QRコードも欲しい場合はURL行とは別に `!qr URL` を書きます。QRだけ欲しい場合は `!qr URL` の行だけを書きます。

コード種別やデータ文字列は印字されず、コード本体だけが印字されます。以下の `-notext` 系も互換用に使えます。
`!preview` では確認用に `[QRコード]` や `[バーコード]` とだけ表示され、データ文字列は表示されません。
バーコード下の人間可読テキストを出すかどうかは管理者設定 `BARCODE_HRI` で切り替えます。出したくない場合は管理者に `BARCODE_HRI=none` を設定してもらってください。

```text
!qr-notext https://example.com
!print-code-notext qr https://example.com
!code-notext code128 ABC123
```

複数行を1投稿にまとめると、1つの印刷ジョブとして順番に印刷します。
`[URL QR]` や `[CODE PRINT]` のようなデバッグ用ヘッダーは印字されません。

```text
通常文の上
!print-code qr https://example.com
!print-code code128 ABC123
通常文の下
```

短縮名:

- `gs1128`: GS1-128
- `databar`: GS1 DataBar Omnidirectional
- `code128c`: CODE 128 Code Set C

対応種別:
UPC-A、UPC-E、JAN/EAN 8、JAN/EAN 13、CODE 39、ITF、CODABAR/NW-7、CODE 93、CODE 128、GS1-128、GS1 DataBar 系、PDF417、QR Code、MaxiCode、Composite Symbology。

### コード印刷コマンド一覧

基本形:

```text
!print-code 種別 データ
!code 種別 データ
!barcode 種別 データ
```

互換用の別名:

```text
!print-code-notext 種別 データ
!code-notext 種別 データ
!barcode-notext 種別 データ
```

QRだけの短縮形:

```text
!qr データ
!qr-notext データ
```

使える種別名:

| 種別                           | 別名                                                           | データ制約・注意                                                                              |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `qr`                           | `qrcode`, `qr_code`                                            | 日本語やURL可。最大7089 bytes相当。                                                           |
| `pdf417`                       | なし                                                           | 日本語可。最大928 bytes相当                                                                   |
| `maxicode`                     | なし                                                           | 日本語可。最大138 bytes相当                                                                   |
| `jan13`                        | `ean13`                                                        | 数字12桁または13桁が実用範囲                                                                  |
| `jan8`                         | `ean8`                                                         | 数字7桁または8桁が実用範囲                                                                    |
| `upc_a`                        | `upca`                                                         | 数字11桁または12桁が実用範囲                                                                  |
| `upc_e`                        | `upce`                                                         | 数字11桁または12桁が実用範囲                                                                  |
| `code39`                       | `code_39`                                                      | `0-9`, `A-Z`, スペース, `-`, `.`, `/`, `$`, `%`, `+` のみ。58mmでは約12文字まで推奨           |
| `itf`                          | なし                                                           | 数字推奨。偶数桁推奨。58mmでは約18桁まで推奨                                                  |
| `codabar`                      | `nw7`                                                          | ASCIIのみ。58mmでは約16文字まで推奨                                                           |
| `code93`                       | `code_93`                                                      | ASCIIのみ。58mmでは約16文字まで推奨                                                           |
| `code128`                      | `code_128`                                                     | ASCIIのみ。数字のみ偶数桁なら自動でCode Set C。58mmでは英数字約14文字、数字のみ約28桁まで推奨 |
| `code128c`                     | `code128num`, `code128_numeric`                                | 数字のみ、偶数桁必須。58mmでは約28桁まで推奨                                                  |
| `gs1_128`                      | `gs1128`, `gs1`                                                | ASCIIのみ。`(01)04901234567890` のようなAI括弧は自動で除去。58mmでは約28桁相当まで推奨        |
| `gs1_databar_omni`             | `databar`, `gs1_databar`, `gs1databar`, `databar_omni`, `omni` | ASCIIのみ。58mmでは約16文字まで推奨                                                           |
| `gs1_databar_truncated`        | `databar_truncated`                                            | ASCIIのみ。58mmでは約16文字まで推奨                                                           |
| `gs1_databar_limited`          | `databar_limited`                                              | ASCIIのみ。58mmでは約16文字まで推奨                                                           |
| `gs1_databar_expanded`         | `databar_expanded`                                             | ASCIIのみ。58mmでは約16文字まで推奨                                                           |
| `gs1_databar_stacked`          | `databar_stacked`                                              | ASCIIのみ。2D GS1 DataBar系                                                                   |
| `gs1_databar_stacked_omni`     | `databar_stacked_omni`                                         | ASCIIのみ。2D GS1 DataBar系                                                                   |
| `gs1_databar_expanded_stacked` | `databar_expanded_stacked`                                     | ASCIIのみ。2D GS1 DataBar系                                                                   |
| `composite`                    | なし                                                           | 現在の本文コマンドでは補助データ指定が限定的です。失敗する場合は管理者に相談                  |

注意:

- 1次元コードは紙幅に収まらない場合、印刷前にエラーになります。
- 58mm/384dots前提の目安です。プリンタ設定や紙幅が違う場合、上限も変わります。
- `code39` は長いIDに不向きです。長い英数字IDは `code128` か `qr` を使ってください。

### CODE128のコードセット切替・ファンクション

`code128` では、データの途中にEPSON形式の制御トークンを記述できます。

```text
!print-code code128 {BABC{C123456{BXYZ
!print-code code128 {BABC{1DEF
```

- `{A` / `{B` / `{C`: Code Set A / B / Cへ切替
- `{S`: SHIFT（AとBを次の1文字だけ切替）
- `{1` / `{2` / `{3` / `{4`: FNC1 / FNC2 / FNC3 / FNC4
- `{{`: データとしての左波括弧 `{`
- 明示制御形式は必ず `{A`、`{B`、`{C` のいずれかで開始してください。
- Code Set Cの通常データは数字2桁単位です。例: `{C123456`

### 長い一次元バーコードの90度回転

横幅に収まらない一次元バーコードは、バーコード画像を生成して紙送り方向へ90度回転できます。プリンターのページモードによる範囲外判定を避けるため、90度印刷時だけラスタ画像として送信します。

```text
!print-code-90 code128 {BABC{C12345678901234567890
!print-code-90-notext gs1128 (01)04901234567890(10)LOT123
```

- 対応対象は一次元バーコードです。QR、PDF417、MaxiCode、Compositeには使用できません。
- 最大長は2048 dotsです。長いほど紙を多く使用します。
- バーコードの高さが用紙幅方向になるため、通常のバーコード高さ設定は用紙幅以内にしてください。

### GS1-128のAI表記

GS1アプリケーション識別子は括弧付きで指定できます。括弧自体はバーコードデータに含まれません。可変長AIが後続項目より前にある場合、FNC1が自動挿入されます。

```text
!print-code gs1128 (01)04901234567890
!print-code gs1128 (10)A(17)270101
```

AIごとの固定長・最大長を検査します。未登録のAIを使用する場合は、`{A` / `{B` / `{C` と `{1` を使った明示制御形式で指定してください。
複数AIや長いロット番号を組み合わせると58mmの印字幅を超えることがあります。その場合はデータを短くするか、GS1対応の二次元コードを使用してください。
- JAN/EAN/UPCは桁数やチェックデジットが規格に合わないと、プリンタ側で印字されないことがあります。
- QR/PDF417/MaxiCode以外のコードはASCIIのみです。日本語や絵文字は使えません。
- バッククォートやコードブロックの囲み記号は無視され、中身は通常どおりURL検出やコマンド実行の対象になります。

## 再印刷

過去の投稿をもう一度印刷できます。

```text
!reprint 1513138512247918662
!reprint https://discord.com/channels/サーバーID/チャンネルID/メッセージID
```

対象メッセージへの返信として `!reprint` だけ投稿することもできます。

## レイアウト

行頭に制御コマンドを書くと、その行は印字せず、後続の印刷設定を変更します。

### 全コマンド一覧

- `!left` / `!center` / `!right`: 揃え位置
- `!align left|center|right`: 揃え位置
- `!row 左側 | 右側`: 左寄せテキストと右寄せ金額を同じ行に印字
- `!img 1`: 1番目の添付画像をその位置に印字。指定した画像は末尾で重複印字しません
- `!img 1 50%`: 1番目の添付画像を紙幅の50%以内で印字。`50` だけでも可
- `!img-notext 1 50%`: 画像ファイル名ラベルなしで画像だけ印字
- `!rule -` / `!rule *`: 区切り線
- `!blank 2`: 空行
- `!box text`: `* text *` 形式の注意書き
- `!bold on|off`: 太字
- `**太字**`: Discord の太字をプリンタ太字で印刷
- `!underline on|off|2`: 下線。`2` は太線
- `__下線__`: Discord の下線をプリンタ下線で印刷
- `!doublestrike on|off`: 二重印字
- `!invert on|off`: 白黒反転
- `!rotate on|off`: 90度回転
- `!upsidedown on|off`: 倒立印字
- `!font a|b`: 内蔵フォント切り替え
- `!smoothing on|off`: スムージング
- `!printmode font=a bold=on double-width=on double-height=off underline=off`: 印字モード一括指定
- `!small on|off`: 小さいフォント
- `!size 1-8 1-8`: 横倍率・縦倍率
- `!normal`: 太字、下線、反転、回転、倍率、揃えを標準へ戻す
- `!reset`: プリンタ初期化
- `!linespacing 24` / `!linespacing default`: 行間
- `!charspacing 0`: 文字間隔
- `!tab`: 水平タブ
- `!tabs 8 16 24`: タブ位置
- `!feed 3`: 改行
- `!feeddots 48`: ドット単位紙送り
- `!position 120`: 横方向の絶対位置
- `!relative 24`: 横方向の相対移動
- `!margin 0`: 左マージン
- `!width 384`: 印字領域幅
- `!motion 203 203`: 基本計算ピッチ
- `!cut partial|partial3|full|none`: その場でカット
- `!drawer 0 80 240`: キャッシュドロアー用パルス
- `!buzzer 1 1 3`: ブザー

例:

```text
!center
領収書
!left
!rule -
!row 商品A | ¥500
!row 外税 | ¥40
!bold on
!size 2 1
!row 合計 | ¥540
!size 1 1
!bold off
```

ページモード:

```text
!page begin
!page area 0 0 384 300
!page direction left-to-right
!page position 20 40
!page relative 24
ページモード内の文字
!page print
!page end
```

注意:

- `!row` は `!small` や `!size` の状態を見て右側を揃えます。倍率を大きくすると使える文字数は減ります。
- `!img n` の番号は、その投稿に添付された画像だけを1始まりで数えます。絵文字画像や埋め込み画像は番号対象外です。
- `!img-notext` は画像ラベルを印字しませんが、`!preview` では確認用に `[画像n: ラベルなし]` と表示します。
- `!cut` はその場でカットします。転送メッセージや複数ブロックの途中で使うと途中で切れます。
- ページモードは機種・ドライバー・現在状態により無視される命令があります。通常のレシートでは標準モードの `!left`、`!center`、`!right`、`!row`、`!bold`、`!size` を推奨します。

## 上級者向けコマンド

raw ESC/POS 印刷は許可ユーザーだけが使えます。使えるかどうかは bot 管理者に確認してください。

```text
!raw-escpos 1B 40 48 65 6C 6C 6F 0A
```

raw ESC/POS は通常ヘッダー、通し番号、自動カットを追加しません。バイト列がそのままプリンタへ送られます。
