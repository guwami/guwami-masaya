"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSessionId,
  fetchKintoteHistory,
  saveKintoteRecord,
  validateKintotePayload,
  type KintoteRecord,
} from "../lib/supabaseKintote";
import styles from "./page.module.css";

type SensorPermission = "unknown" | "granted" | "denied" | "unsupported";
type PeakDirection = "up" | "down";
type Unit = "kg" | "lb";
type LoadLevel = 1 | 2 | 3 | 4 | 5;
type AppTab = "home" | "measure" | "data" | "analysis";

type MotionPermissionEvent = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type Machine = {
  name: string;
  targets: string;
};

type AnalysisRow = {
  machine: string;
  total: number;
  sessions: number;
};

const MACHINES: Machine[] = [
  { name: "チェストプレス", targets: "胸・上腕三頭筋・肩前部" },
  { name: "ラットプルダウン", targets: "広背筋・僧帽筋・上腕二頭筋" },
  { name: "シーテッドロー", targets: "背中全体・広背筋・僧帽筋" },
  { name: "ショルダープレス", targets: "肩・上腕三頭筋" },
  { name: "レッグプレス", targets: "太もも・お尻" },
  { name: "レッグエクステンション", targets: "大腿四頭筋" },
  { name: "レッグカール", targets: "ハムストリング" },
  { name: "ヒップアブダクション", targets: "中臀筋・お尻外側" },
  { name: "ヒップアダクション", targets: "内転筋" },
  { name: "グルートマシン", targets: "大臀筋" },
  { name: "アブドミナルクランチ", targets: "腹直筋" },
  { name: "バックエクステンション", targets: "脊柱起立筋・腰" },
  { name: "スミスマシン", targets: "全身・種目による" },
  { name: "ケーブルクロスオーバー", targets: "胸・肩・腕" },
  { name: "ペックフライ", targets: "胸内側・肩前部" },
  { name: "アシストチンニング", targets: "広背筋・腕" },
  { name: "カーフレイズマシン", targets: "ふくらはぎ" },
  { name: "ハックスクワット", targets: "太もも・お尻" },
  { name: "ロータリートルソー", targets: "腹斜筋・体幹" },
  { name: "アームカールマシン", targets: "上腕二頭筋" },
  { name: "トライセプスエクステンション", targets: "上腕三頭筋" },
];

const BASELINE_ALPHA = 0.02;
const SMOOTHING_ALPHA = 0.25;
const PEAK_THRESHOLD = 2.1;
const RELEASE_THRESHOLD = 0.75;
const MIN_REP_INTERVAL_MS = 450;
const SET_IDLE_MS = 10_000;
const MICRO_MOVEMENT_THRESHOLD = 0.9;
const KG_WEIGHTS = Array.from({ length: 41 }, (_, index) => index * 2.5);
const LB_WEIGHTS = Array.from({ length: 41 }, (_, index) => index * 5);

const getAccelerationScore = (upPeak: number, downPeak: number) => {
  if (upPeak <= 0 || downPeak <= 0) return { ratio: 0, score: 1 };

  const ratio = (downPeak / upPeak) * 100;
  if (ratio < 40) return { ratio, score: 10 };
  if (ratio < 70) return { ratio, score: 5 };
  return { ratio, score: 1 };
};

const getCountScore = (continuousCount: number) => {
  if (continuousCount >= 10) return 10;
  if (continuousCount >= 5) return 5;
  if (continuousCount >= 1) return 2;
  return 1;
};

const getLoadLevel = (loadScore: number): LoadLevel => {
  if (loadScore >= 80) return 5;
  if (loadScore >= 40) return 4;
  if (loadScore >= 20) return 3;
  if (loadScore >= 8) return 2;
  return 1;
};

function formatDate(value: string | null) {
  if (!value) return "日時なし";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getMachineName(parts: string | null) {
  if (!parts) return "マシン未設定";
  return parts.split("（")[0] || parts;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [completedSetCounts, setCompletedSetCounts] = useState<number[]>([]);
  const [continuousCount, setContinuousCount] = useState(0);
  const [sensorPermission, setSensorPermission] = useState<SensorPermission>("unknown");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [weightIndex, setWeightIndex] = useState(8);
  const [unit, setUnit] = useState<Unit>("kg");
  const [loadLevel, setLoadLevel] = useState<LoadLevel>(1);
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [records, setRecords] = useState<KintoteRecord[]>([]);
  const [historyStatus, setHistoryStatus] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);

  const isRunningRef = useRef(false);
  const baselineRef = useRef<number | null>(null);
  const smoothedSignalRef = useRef(0);
  const armedPeaksRef = useRef<Record<PeakDirection, boolean>>({ up: true, down: true });
  const detectedPeaksRef = useRef<Set<PeakDirection>>(new Set());
  const lastRepTimeRef = useRef<number | null>(null);
  const currentUpPeakRef = useRef(0);
  const currentDownPeakRef = useRef(0);
  const setTimerRef = useRef<number | null>(null);

  const weightOptions = unit === "kg" ? KG_WEIGHTS : LB_WEIGHTS;
  const selectedWeight = weightOptions[weightIndex] ?? weightOptions[0];
  const machineParts = selectedMachine ? `${selectedMachine.name}（${selectedMachine.targets}）` : "";
  const allSetCounts = count > 0 ? [...completedSetCounts, count] : completedSetCounts;
  const totalRepCount = allSetCounts.reduce((sum, setCount) => sum + setCount, 0);
  const loadLevelLabel = useMemo(() => `レベル${loadLevel}`, [loadLevel]);
  const tabs: { key: AppTab; label: string }[] = [
    { key: "home", label: "ホーム" },
    { key: "measure", label: "計測" },
    { key: "data", label: "データ" },
    { key: "analysis", label: "分析" },
  ];

  const analysisRows = useMemo<AnalysisRow[]>(() => {
    const grouped = records.reduce<Record<string, AnalysisRow>>((accumulator, record) => {
      const machine = getMachineName(record.parts);
      if (!accumulator[machine]) {
        accumulator[machine] = { machine, total: 0, sessions: 0 };
      }
      accumulator[machine].total += record.number ?? 0;
      accumulator[machine].sessions += 1;
      return accumulator;
    }, {});

    return Object.values(grouped).sort((a, b) => b.total - a.total);
  }, [records]);
  const maxAnalysisTotal = Math.max(...analysisRows.map((row) => row.total), 1);

  const clearSetTimer = useCallback(() => {
    if (setTimerRef.current !== null) {
      window.clearTimeout(setTimerRef.current);
      setTimerRef.current = null;
    }
  }, []);

  const armSetTimer = useCallback(() => {
    clearSetTimer();
    setTimerRef.current = window.setTimeout(() => {
      if (lastRepTimeRef.current === null) return;

      setCount((currentCount) => {
        if (currentCount > 0) {
          setCompletedSetCounts((currentSets) => [...currentSets, currentCount]);
        }
        return 0;
      });
      setContinuousCount(0);
      setLoadLevel(1);
      detectedPeaksRef.current = new Set();
      lastRepTimeRef.current = null;
      currentUpPeakRef.current = 0;
      currentDownPeakRef.current = 0;
      setTimerRef.current = null;
    }, SET_IDLE_MS);
  }, [clearSetTimer]);

  const resetRuntimeRefs = useCallback(() => {
    baselineRef.current = null;
    smoothedSignalRef.current = 0;
    armedPeaksRef.current = { up: true, down: true };
    detectedPeaksRef.current = new Set();
    lastRepTimeRef.current = null;
    currentUpPeakRef.current = 0;
    currentDownPeakRef.current = 0;
    clearSetTimer();
  }, [clearSetTimer]);

  const stopMeasurement = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    clearSetTimer();
  }, [clearSetTimer]);

  const resetMeasurement = useCallback(() => {
    stopMeasurement();
    resetRuntimeRefs();
    setCount(0);
    setCompletedSetCounts([]);
    setContinuousCount(0);
    setLoadLevel(1);
    setSaveStatus("");
  }, [resetRuntimeRefs, stopMeasurement]);

  const loadHistory = useCallback(async () => {
    setHistoryStatus("");
    setIsHistoryLoading(true);

    try {
      const history = await fetchKintoteHistory();
      setRecords(history);
      setHistoryStatus(history.length ? `${history.length}件のデータを読み込みました。` : "保存済みのデータはまだありません。");
    } catch (error) {
      setHistoryStatus(error instanceof Error ? error.message : "データの読み込みに失敗しました。");
    } finally {
      setIsHistoryLoading(false);
    }
  }, []);

  const processPeak = useCallback(
    (direction: PeakDirection, now: number) => {
      detectedPeaksRef.current.add(direction);

      if (!detectedPeaksRef.current.has("up") || !detectedPeaksRef.current.has("down")) {
        return;
      }

      const previousRepTime = lastRepTimeRef.current;
      if (previousRepTime !== null && now - previousRepTime < MIN_REP_INTERVAL_MS) {
        return;
      }

      lastRepTimeRef.current = now;
      detectedPeaksRef.current = new Set();
      const { score: nextAccelerationScore } = getAccelerationScore(
        currentUpPeakRef.current,
        currentDownPeakRef.current,
      );

      setCount((currentCount) => currentCount + 1);
      setContinuousCount((currentContinuousCount) => {
        const nextContinuousCount = currentContinuousCount + 1;
        const nextCountScore = getCountScore(nextContinuousCount);
        const nextLoadScore = nextAccelerationScore * nextCountScore;

        setLoadLevel(getLoadLevel(nextLoadScore));
        return nextContinuousCount;
      });
      currentUpPeakRef.current = 0;
      currentDownPeakRef.current = 0;
      armSetTimer();
    },
    [armSetTimer],
  );

  const handleMotion = useCallback(
    (event: DeviceMotionEvent) => {
      if (!isRunningRef.current) return;

      const acceleration = event.accelerationIncludingGravity ?? event.acceleration;
      const rawZ = acceleration?.z;
      if (typeof rawZ !== "number") return;

      const previousBaseline = baselineRef.current ?? rawZ;
      const baseline = previousBaseline + (rawZ - previousBaseline) * BASELINE_ALPHA;
      baselineRef.current = baseline;

      const highPassSignal = rawZ - baseline;
      const smoothedSignal = smoothedSignalRef.current + (highPassSignal - smoothedSignalRef.current) * SMOOTHING_ALPHA;
      smoothedSignalRef.current = smoothedSignal;

      if (Math.abs(smoothedSignal) < MICRO_MOVEMENT_THRESHOLD) {
        return;
      }

      if (smoothedSignal > currentUpPeakRef.current) {
        currentUpPeakRef.current = smoothedSignal;
      }

      if (Math.abs(smoothedSignal) > currentDownPeakRef.current && smoothedSignal < 0) {
        currentDownPeakRef.current = Math.abs(smoothedSignal);
      }

      const now = performance.now();

      if (smoothedSignal > PEAK_THRESHOLD && armedPeaksRef.current.up) {
        armedPeaksRef.current.up = false;
        processPeak("up", now);
      }

      if (smoothedSignal < RELEASE_THRESHOLD) {
        armedPeaksRef.current.up = true;
      }

      if (smoothedSignal < -PEAK_THRESHOLD && armedPeaksRef.current.down) {
        armedPeaksRef.current.down = false;
        processPeak("down", now);
      }

      if (smoothedSignal > -RELEASE_THRESHOLD) {
        armedPeaksRef.current.down = true;
      }
    },
    [processPeak],
  );

  const startMeasurement = useCallback(async () => {
    setErrorMessage("");
    setSaveStatus("");

    if (!selectedMachine) {
      setActiveTab("home");
      setErrorMessage("先にホームでマシンを選択してください。");
      return;
    }

    if (typeof window === "undefined" || typeof window.DeviceMotionEvent === "undefined") {
      setSensorPermission("unsupported");
      setErrorMessage("この端末またはブラウザでは加速度センサーを利用できません。");
      return;
    }

    const motionEvent = window.DeviceMotionEvent as MotionPermissionEvent;

    try {
      if (typeof motionEvent.requestPermission === "function") {
        const permission = await motionEvent.requestPermission();
        setSensorPermission(permission);
        if (permission !== "granted") {
          setErrorMessage("加速度センサーの利用が許可されませんでした。Safariの権限設定を確認してください。");
          return;
        }
      } else {
        setSensorPermission("granted");
      }

      resetMeasurement();
      isRunningRef.current = true;
      setIsRunning(true);
    } catch {
      setSensorPermission("denied");
      setErrorMessage("センサー権限のリクエスト中にエラーが発生しました。iOS SafariでHTTPS接続から開いてください。");
    }
  }, [resetMeasurement, selectedMachine]);

  const handleSaveMeasurement = useCallback(async () => {
    setSaveStatus("");

    try {
      const payload = validateKintotePayload({
        sessionId,
        parts: machineParts,
        count: totalRepCount,
        weight: String(Math.round(selectedWeight)),
      });
      setIsSaving(true);
      await saveKintoteRecord(payload);
      setSaveStatus(`Supabaseに${allSetCounts.length}セット・合計${totalRepCount}回を保存しました。`);
      await loadHistory();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }, [allSetCounts.length, loadHistory, machineParts, selectedWeight, sessionId, totalRepCount]);

  const handleSelectMachine = useCallback((machine: Machine) => {
    setSelectedMachine(machine);
    resetMeasurement();
    setActiveTab("measure");
  }, [resetMeasurement]);

  const handleTabChange = useCallback((tab: AppTab) => {
    setActiveTab(tab);
    if (tab === "data" || tab === "analysis") {
      void loadHistory();
    }
  }, [loadHistory]);

  useEffect(() => {
    setSessionId(String(createSessionId()));
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!isRunning) return;
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, [handleMotion, isRunning]);

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      clearSetTimer();
    };
  }, [clearSetTimer]);

  return (
    <main className={styles.appShell}>
      <nav className={styles.tabBar} aria-label="メインタブ">
        {tabs.map((tab) => (
          <button
            className={`${styles.tabButton} ${activeTab === tab.key ? styles.tabButtonActive : ""}`}
            type="button"
            key={tab.key}
            onClick={() => handleTabChange(tab.key)}
            aria-current={activeTab === tab.key ? "page" : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "home" && (
        <section className={styles.tabPanel} aria-labelledby="home-title">
          <div className={styles.hero}>
            <p className={styles.kicker}>Machine Select</p>
            <h1 id="home-title" className={styles.title}>ホーム</h1>
            <p className={styles.description}>筋トレのマシンを選択してください。選択すると計測タブへ移動します。</p>
          </div>

          <div className={styles.machineGrid} aria-label="筋トレマシン一覧">
            {MACHINES.map((machine) => (
              <button
                className={styles.machineButton}
                type="button"
                key={machine.name}
                onClick={() => handleSelectMachine(machine)}
              >
                <span>{machine.name}</span>
                <small>{machine.targets}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeTab === "measure" && (
        <section className={styles.measurePanel} aria-labelledby="measure-title">
          <header className={styles.measureHeader}>
            <p className={styles.kicker}>Measurement</p>
            <h1 id="measure-title" className={styles.measureTitle}>{selectedMachine?.name ?? "マシン未選択"}</h1>
            <p className={styles.description}>{selectedMachine?.targets ?? "ホームタブでマシンを選択してください。"}</p>
          </header>

          <section className={styles.weightPanel} aria-label="重量選択">
            <label className={styles.dialLabel} htmlFor="weight-dial">
              <span>重さ</span>
              <strong>{selectedWeight}{unit}</strong>
            </label>
            <div className={styles.weightControls}>
              <input
                id="weight-dial"
                className={styles.weightDial}
                type="range"
                min="0"
                max={weightOptions.length - 1}
                step="1"
                value={weightIndex}
                onChange={(event) => setWeightIndex(Number(event.target.value))}
              />
              <button
                className={styles.unitToggle}
                type="button"
                aria-pressed={unit === "lb"}
                onClick={() => setUnit((current) => (current === "kg" ? "lb" : "kg"))}
              >
                {unit === "kg" ? "kg" : "lb"}
              </button>
            </div>
          </section>

          {errorMessage && <p className={styles.errorMessage} role="alert">{errorMessage}</p>}

          <section className={`${styles.measureArea} ${styles[`loadLevel${loadLevel}`]}`} aria-live="polite">
            <div className={styles.statusRow}>
              <span className={isRunning ? styles.runningDot : styles.idleDot} />
              <span>{isRunning ? "計測中" : totalRepCount > 0 ? "停止中" : "スタート待ち"}</span>
            </div>
            <p className={styles.setCount}>現在 {allSetCounts.length || 1}セット目</p>
            <div className={styles.countNumber}>{count}</div>
            <p className={styles.loadLabel}>{loadLevelLabel}</p>
          </section>

          <section className={styles.setSummary} aria-label="セットごとの回数">
            {allSetCounts.length ? (
              allSetCounts.map((setCount, index) => (
                <div
                  className={`${styles.setChip} ${index % 2 === 0 ? styles.setChipGreen : styles.setChipRed}`}
                  key={`${index}-${setCount}`}
                >
                  <span>{index + 1}セット</span>
                  <strong>{setCount}回</strong>
                </div>
              ))
            ) : (
              <p className={styles.emptyState}>一定時間無検知になると、セットごとの回数がここに表示されます。</p>
            )}
          </section>

          <section className={styles.actionArea} aria-label="操作エリア">
            <button
              className={isRunning ? styles.stopButtonInline : styles.startButton}
              type="button"
              onClick={isRunning ? stopMeasurement : startMeasurement}
              disabled={!selectedMachine}
            >
              {isRunning ? "ストップ" : "スタート"}
            </button>
            <button className={styles.saveButton} type="button" onClick={handleSaveMeasurement} disabled={isSaving || totalRepCount === 0 || !selectedMachine}>
              {isSaving ? "保存中..." : "保存"}
            </button>
            {saveStatus && <p className={styles.saveStatus}>{saveStatus}</p>}
          </section>
        </section>
      )}

      {activeTab === "data" && (
        <section className={styles.tabPanel} aria-labelledby="data-title">
          <div className={styles.sectionTitleRow}>
            <div>
              <p className={styles.kicker}>Saved Data</p>
              <h1 id="data-title" className={styles.sectionTitle}>データ</h1>
            </div>
            <button className={styles.refreshButton} type="button" onClick={loadHistory} disabled={isHistoryLoading}>
              {isHistoryLoading ? "読込中" : "更新"}
            </button>
          </div>
          {historyStatus && <p className={styles.saveStatus}>{historyStatus}</p>}
          <div className={styles.historyList} aria-label="保存したデータ一覧">
            {records.map((record) => (
              <article className={styles.historyCard} key={`${record.name}-${record.created_at ?? "no-date"}`}>
                <div>
                  <p className={styles.historyParts}>{getMachineName(record.parts)}</p>
                  <p className={styles.historyMeta}>{record.parts || "部位未入力"}</p>
                  <p className={styles.historyMeta}>ID: {record.name} ・ {formatDate(record.created_at)}</p>
                </div>
                <div className={styles.historyNumbers}>
                  <span>{record.number}回</span>
                  <small>{record.weight === null ? "重量なし" : `${record.weight}kg`}</small>
                </div>
              </article>
            ))}
            {!records.length && <p className={styles.emptyState}>保存したデータがここに羅列されます。</p>}
          </div>
        </section>
      )}

      {activeTab === "analysis" && (
        <section className={styles.tabPanel} aria-labelledby="analysis-title">
          <div className={styles.sectionTitleRow}>
            <div>
              <p className={styles.kicker}>Graph</p>
              <h1 id="analysis-title" className={styles.sectionTitle}>分析</h1>
            </div>
            <button className={styles.refreshButton} type="button" onClick={loadHistory} disabled={isHistoryLoading}>
              {isHistoryLoading ? "読込中" : "更新"}
            </button>
          </div>
          <div className={styles.analysisList} aria-label="マシンごとの合計回数グラフ">
            {analysisRows.map((row) => (
              <article className={styles.analysisCard} key={row.machine}>
                <div className={styles.analysisMeta}>
                  <strong>{row.machine}</strong>
                  <span>{row.sessions}回保存 / 合計{row.total}回</span>
                </div>
                <div className={styles.barTrack} aria-hidden="true">
                  <div className={styles.barFill} style={{ width: `${Math.max((row.total / maxAnalysisTotal) * 100, 6)}%` }} />
                </div>
              </article>
            ))}
            {!analysisRows.length && <p className={styles.emptyState}>保存すると、マシンごとの合計回数がグラフで表示されます。</p>}
          </div>
        </section>
      )}
    </main>
  );
}
