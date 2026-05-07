# guwami-masaya

筋トレをする時に便利なモバイルアプリです。iPhone の加速度センサーで上下往復をカウントし、Supabase の `kintote` テーブルに保存できます。

## Supabase 連携に必要な情報

アプリ内の API URL は次を使用しています。

```text
https://uwvkltzkchwqjqznzutg.supabase.co/rest/v1
```

保存・履歴表示には Supabase の **anon key** が必要です。キーは画面で入力せず、サーバー側の環境変数 `SUPABASE_ANON_KEY` から自動で使用します。

ローカル起動時は `.env.local` に次の形式で設定してください（`.env.local` は Git 管理対象外です）。

```bash
SUPABASE_ANON_KEY=your_supabase_anon_key
```

> `sb_secret_...` のような secret key を使う場合もブラウザへ公開しないよう、`NEXT_PUBLIC_` ではなく `SUPABASE_ANON_KEY` に設定してください。

## `kintote` テーブル

添付画像の構成に合わせて、次の列に保存します。

| Supabase列 | 型 | アプリで入力・保存する値 |
| --- | --- | --- |
| `name` | `int4` | 記録ID。アプリで自動発行できます。主キー想定のため重複しない値が必要です。 |
| `parts` | `text` | 部位・種目名。保存前に入力します。 |
| `number` | `int2` | 計測した回数。カウンターの値を保存します。 |
| `weight` | `int2` | 重量。任意入力です。自重トレーニングは空欄で保存します。 |
| `created_at` | `timestamptz` | 保存時刻。アプリが ISO 形式で送信します。 |

## Supabase 側で必要な操作

REST API でブラウザから `insert` と `select` を実行するため、RLS を有効にしている場合は `anon` ロール用のポリシーが必要です。公開アプリとして使う場合は認証やユーザー別制限を追加してください。

最小構成の例:

```sql
alter table public.kintote enable row level security;

create policy "Allow anon insert kintote"
on public.kintote
for insert
to anon
with check (true);

create policy "Allow anon select kintote"
on public.kintote
for select
to anon
using (true);
```

また、Supabase の API 設定で `kintote` テーブルが `public` schema にあり、REST API から公開されていることを確認してください。
