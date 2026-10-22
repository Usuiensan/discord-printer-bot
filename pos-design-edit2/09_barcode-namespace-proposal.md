# 09. バーコード名前空間案

## 1. 状態

- ADR: D020
- 状態: `Proposed`
- 確定済み: 取引番号はcanonical `YYYY-MMDD-NNNNNN`、レシート表示 `YYYY-MMDD-NNN-NNN`。
- 目的: 返品用伝票、取り置き、外部商品コード、POS内部商品コードを一台のバーコードリーダーで曖昧なく識別する。

## 2. 再検討の結論

ISDNはISBN-13に準じた13桁で、先頭278〜279を作品番号、292を価格等の2段目バーコードに使用する。いずれもインストアコード20x〜29xを利用している。

Crockford Base32は `I/L/O/U` を除外し、人が英数字を転記する用途には適している。しかし本件では、人間が読む伝票番号・取り置き番号・商品コードをバーコードpayloadとは別に印字する。scanner専用tokenへBase32を使う利点より、Code 128のsubset Cで数字を2桁ずつ圧縮できる利点の方が大きい。

提案を次のように改める。

1. `T1/H1/P1` の単独英字種別を廃止する。
2. 全内部barcodeにmagic `PS`、version数字、type数字を付ける。
3. subject IDは日付・連番・UUIDを直接埋めず、14桁の暗号学的乱数tokenとする。
4. 数字部全体へLuhn検査数字を1桁付け、Code 128自体のchecksumと二重に誤読・転記を検出する。
5. 内部商品tokenにもCrockford Base32を使わず、同じ数字token方式を使う。
6. 数字だけの値はすべて商品barcode候補として許可する。20x〜29x、278〜279、292を禁止領域にしない。
7. POSは数字だけの内部コードを発番しないため、商品コード空間にシステム用使用不可領域を作らない。

参考: https://isdn.jp/about.html

## 3. 提案するコード

| 対象 | 人間向け表示 | Code 128 payload | 用途 |
| --- | --- | --- | --- |
| 取引伝票 | `2026-0724-123-456` | `PS11483920174625386` | 返品、取消、再印刷、照会 |
| 取り置き | `H-2026-0724-000-123` | `PS12104857392640176` | 受取、解除、照会 |
| 内部商品 | 任意の商品コード | `PS13725031946820547` | POS発行の商品ラベル |
| 外部商品 | EAN/UPC/ISBN/ISDN表記 | 元の数字payload | 商品登録 |

内部payloadは19文字固定で、構造は `PS V T RRRRRRRRRRRRRR C` とする。

- `PS`: POS内部であることを示すmagic
- `V`: version。初版は `1`
- `T`: type。`1=transaction`、`2=hold`、`3=product`
- `R`: CSPRNGで生成する14桁token
- `C`: `V + T + R` に対するLuhn検査数字

tokenはDBのunique制約に違反した場合に再生成する。token自体を認証情報として扱わず、resolve後の操作では権限とsubject状態を再検証する。

レシートには人間向け伝票番号と `PS11...` のCode 128を併記する。取り置き票には `H-...` と `PS12...` を併記する。内部商品ラベルは商品コードと `PS13...` を併記する。数字部をCode 128 subset Cで圧縮する。実際のmodule幅、高さ、quiet zone、58 mm紙での読取りは実機試験で確定する。

## 4. scanner router

scanner入力は各画面が直接解釈せず、サーバー共通の `BarcodeRouter` へ渡す。

判定順:

1. `PS` + 17数字かつLuhn正常: version/typeにより内部subjectを検索
2. 数字だけの値: event内の `product_barcodes.normalized_payload` を完全一致検索
3. 未登録の8/12/13/14桁数字: GTIN check digitを検証し、商品未登録として返す
4. event内の明示登録済み英数字custom barcodeを完全一致検索
5. どれにも一致しなければunknownとしてエラー

重要な拒否規則:

- `PS` で始まるがversion/type/長さ/Luhnが不正な値を、商品コードや現金入力へfallbackしない。
- 一つのscan payloadを複数の商品または複数種別へ登録できない。
- 有効なGTINと同じ数字列を別商品のcustom codeへ登録できない。
- 20x〜29x、278/279/292を含む数字barcodeも通常の商品barcodeとして登録・検索できる。prefixを理由に拒否しない。
- scanner入力とキーボードの預り金入力を別bufferにし、barcodeを金額として解釈しない。

## 5. データモデル案

| テーブル | 主要列・制約 |
| --- | --- |
| `product_barcodes` | event_id, product_id, normalized_payload, kind(gtin/ean/upc/isbn/isdn/custom), unique(event_id,normalized_payload) |
| `internal_barcode_tokens` | subject_type(transaction/hold/product), subject_id, random_digits, payload, version, active, unique(payload), unique(subject_type,subject_id,version) |
| `hold_counters` | business_day_id, next_hold_no |

取引番号と取り置き番号は別counterを使用する。同じ日・同じ6桁になっても内部payloadは別tokenであり、typeも異なる。DB参照の正本はUUIDで、バーコードpayloadは検索用alternate keyとする。

`product_code` はevent内の商品管理番号として残せるが、scanner identityの正本にはしない。商品へ複数の外部barcodeを関連付けられるようにする。

## 6. API案

- `POST /barcode/resolve`: payloadを受け、`transaction/hold/product/unknown` と対象IDを返す。
- `POST /admin/products/{id}/barcodes`: 外部barcodeを追加。namespace/check digit/重複を検証する。
- `POST /admin/products/{id}/internal-label`: type 3 tokenのラベルを生成する。
- `GET /transactions/{id}/barcode`: 伝票Code 128用payloadを取得する。
- `GET /holds/{id}/barcode`: 取り置きCode 128用payloadを取得する。

変更系操作はresolve結果だけで実行せず、返されたsubject ID、version、権限、現在状態を各use caseで再検証する。

## 7. 試験

- EAN-8、UPC-A、EAN-13、GTIN-14と、20x〜29x、278/279/292のfixtureを通常の商品barcodeとして登録・解決できる。
- type 1/2/3が商品、現金、相互の種別へ誤分類されない。
- 不正なmagic、version、type、長さ、文字、Luhnを拒否しfallbackしない。
- 同一payloadの二重登録と、別商品への付替え競合を拒否する。
- token生成を大量反復し、DB unique衝突時に再生成される。
- 4レジ同時採番で取引・取り置きbarcodeが一意になる。
- transaction barcodeから返品対象、hold barcodeから受取対象だけを取得する。
- 58 mmレシートと取り置き票を実機印刷し、使用予定scannerで連続100回読取り、誤読・未読を記録する。
- scanner切断、二重送信、末尾Enterの有無、手入力貼付けを試験する。

## 8. 採用時に要件へ追加する事項

- 商品コード8桁以上という既存規則と、barcode namespaceを分離する。
- scanner入力は桁数による商品/預り金推測だけでなく、共通routerを必ず通す。
- 返品、取消、再印刷は伝票barcodeから開始できる。
- 取り置き登録時にhold barcodeを発行し、受取・解除時に利用できる。
- インストアコードを含む数字商品コード領域へシステム用予約・使用不可範囲を設けない。
