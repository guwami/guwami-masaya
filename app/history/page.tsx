"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchKintoteHistory, type KintoteRecord } from "../../lib/supabaseKintote";
import styles from "../page.module.css";

function formatDate(value: string | null) {
  if (!value) return "日時なし";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function HistoryPage() {
  const [records, setRecords] = useState<KintoteRecord[]>([]);
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const totalCount = useMemo(() => records.reduce((sum, record) => sum + (record.number ?? 0), 0), [records]);

  const loadHistory = useCallback(async () => {
    setStatus("");
    setIsLoading(true);

    try {
      const history = await fetchKintoteHistory();
      setRecords(history);
      setStatus(history.length ? `${history.length}件の履歴を読み込みました。` : "保存済みの履歴はまだありません。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "履歴の読み込みに失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  return (
    <main className={styles.appShell}>
      <section className={styles.hero} aria-labelledby="history-title">
        <p className={styles.kicker}>Supabase History</p>
        <h1 id="history-title" className={styles.title}>計測履歴</h1>
        <p className={styles.description}>Supabase の kintote テーブルに保存した回数・部位・重量を新しい順に表示します。</p>
      </section>

      <nav className={styles.navLinks} aria-label="ページ移動">
        <Link href="/">カウンターに戻る</Link>
      </nav>

      <section className={styles.saveSection} aria-labelledby="history-load-title">
        <div className={styles.sectionTitleRow}>
          <div>
            <p className={styles.kicker}>Refresh</p>
            <h2 id="history-load-title" className={styles.sectionTitle}>履歴を読み込む</h2>
          </div>
          <span className={styles.saveCount}>{totalCount} 回</span>
        </div>
        <button className={styles.saveButton} type="button" onClick={loadHistory} disabled={isLoading}>
          {isLoading ? "読み込み中..." : "履歴を更新"}
        </button>
        {status && <p className={styles.saveStatus}>{status}</p>}
        <p className={styles.helpText}>Supabase API key はサーバー側で管理しているため、このページで入力する必要はありません。</p>
      </section>

      <section className={styles.historyList} aria-label="保存済みの計測履歴">
        {records.map((record) => (
          <article className={styles.historyCard} key={`${record.name}-${record.created_at ?? "no-date"}`}>
            <div>
              <p className={styles.historyParts}>{record.parts || "部位未入力"}</p>
              <p className={styles.historyMeta}>ID: {record.name} ・ {formatDate(record.created_at)}</p>
            </div>
            <div className={styles.historyNumbers}>
              <span>{record.number}回</span>
              <small>{record.weight === null ? "重量なし" : `${record.weight}kg`}</small>
            </div>
          </article>
        ))}
        {!records.length && <p className={styles.emptyState}>「履歴を更新」を押すと、kintote テーブルの最新100件を表示します。</p>}
      </section>
    </main>
  );
}
