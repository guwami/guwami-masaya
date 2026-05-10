"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchKintoteHistory,
  saveKintoteRecord,
  parseKintoteErrorMessage,
  validateKintotePayload,
  type KintoteRecord,
} from "../lib/supabaseKintote";
import styles from "./page.module.css";

type SensorPermission = "unknown" | "granted" | "denied" | "unsupported";
type Unit = "kg" | "lb";
type CurrentLevel = 1 | 2 | 3;
type MotionPhase = "idle" | "push" | "pull" | "cooldown";
type RepDuration = {
  pushDuration: number;
  pullDuration: number;
  repDuration: number;
  eccentricRatio: number;
  averageLevel: number;
  level: CurrentLevel;
};
type AppTab = "home" | "measure" | "data" | "analysis";

type MotionPermissionEvent = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type Machine = {
  machineName: string;
  targets: string;
};

type AnalysisRow = {
  machine: string;
  total: number;
  sessions: number;
};

const MACHINES: Machine[] = [
  { machineName: "チェストプレス", targets: "胸・上腕三頭筋・肩前部" },
  { machineName: "ラットプルダウン", targets: "広背筋・僧帽筋・上腕二頭筋" },
  { machineName: "シーテッドロー", targets: "背中全体・広背筋・僧帽筋" },
  { machineName: "ショルダープレス", targets: "肩・上腕三頭筋" },
  { machineName: "レッグプレス", targets: "太もも・お尻" },
  { machineName: "レッグエクステンション", targets: "大腿四頭筋" },
  { machineName: "レッグカール", targets: "ハムストリング" },
  { machineName: "ヒップアブダクション", targets: "中臀筋・お尻外側" },
  { machineName: "ヒップアダクション", targets: "内転筋" },
  { machineName: "グルートマシン", targets: "大臀筋" },
  { machineName: "アブドミナルクランチ", targets: "腹直筋" },
  { machineName: "バックエクステンション", targets: "脊柱起立筋・腰" },
  { machineName: "スミスマシン", targets: "全身・種目による" },
  { machineName: "ケーブルクロスオーバー", targets: "胸・肩・腕" },
  { machineName: "ペックフライ", targets: "胸内側・肩前部" },
  { machineName: "アシストチンニング", targets: "広背筋・腕" },
  { machineName: "カーフレイズマシン", targets: "ふくらはぎ" },
  { machineName: "ハックスクワット", targets: "太もも・お尻" },
  { machineName: "ロータリートルソー", targets: "腹斜筋・体幹" },
  { machineName: "アームカールマシン", targets: "上腕二頭筋" },
  { machineName: "トライセプスエクステンション", targets: "上腕三頭筋" },
];

const BASELINE_ALPHA = 0.02;
const SMOOTHING_ALPHA = 0.25;
const PEAK_THRESHOLD = 2.1;
const RELEASE_THRESHOLD = 0.75;
const MIN_REP_INTERVAL_MS = 450;
const MIN_PHASE_DURATION_MS = 120;
const MIN_PUSH_DURATION_MS = 80;
const WAVEFORM_MAX_POINTS = 96;
const SET_IDLE_MS = 10_000;
const MICRO_MOVEMENT_THRESHOLD = 0.9;
const KG_WEIGHTS = Array.from({ length: 41 }, (_, index) => index * 2.5);
const LB_WEIGHTS = Array.from({ length: 41 }, (_, index) => index * 5);

const getRepLevel = (repDuration: number, eccentricRatio: number): CurrentLevel => {
  if (repDuration >= 2.5 && eccentricRatio >= 0.65) return 3;
  if (repDuration >= 1.8 && eccentricRatio >= 0.55) return 2;
  return 1;
};

const getRecentAverageLevel = (levels: CurrentLevel[]): number => {
  const recentLevels = levels.slice(-5);
  if (!recentLevels.length) return 1;

  return recentLevels.reduce((sum, level) => sum + level, 0) / recentLevels.length;
};

const getLevelBonus = (count: number): number => {
  if (count >= 12) return 0.4;
  if (count >= 8) return 0.2;
  return 0;
};

const getSessionLevelFromAverage = (averageLevel: number): CurrentLevel => {
  const roundedAverageLevel = Math.min(averageLevel, 3);
  if (roundedAverageLevel >= 2.4) return 3;
  if (roundedAverageLevel >= 1.5) return 2;
  return 1;
};

const formatSeconds = (value: number): string => `${value.toFixed(2)}s`;
const formatRatio = (value: number): string => value.toFixed(2);

function formatDate(value: string | null) {
  if (!value) return "日時なし";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}


export default function Home() {
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [completedSetCounts, setCompletedSetCounts] = useState<number[]>([]);
  const [isStopped, setIsStopped] = useState(false);
  const [sensorPermission, setSensorPermission] = useState<SensorPermission>("unknown");
  const [errorMessage, setErrorMessage] = useState("");
  const [weightIndex, setWeightIndex] = useState(8);
  const [unit, setUnit] = useState<Unit>("kg");
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [repDurations, setRepDurations] = useState<RepDuration[]>([]);
  const [repLevels, setRepLevels] = useState<CurrentLevel[]>([]);
  const [currentLevel, setCurrentLevel] = useState<CurrentLevel>(1);
  const [latestRepLevel, setLatestRepLevel] = useState<CurrentLevel>(1);
  const [motionPhase, setMotionPhase] = useState<MotionPhase>("idle");
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [records, setRecords] = useState<KintoteRecord[]>([]);
  const [historyStatus, setHistoryStatus] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [showCompletionModal, setShowCompletionModal] = useState(false);

  const isRunningRef = useRef(false);
  const baselineRef = useRef<number | null>(null);
  const smoothedSignalRef = useRef(0);
  const lastRepTimeRef = useRef<number | null>(null);
  const pushStartTimeRef = useRef<number | null>(null);
  const pullStartTimeRef = useRef<number | null>(null);
  const pushDurationRef = useRef(0);
  const pullDurationRef = useRef(0);
  const motionPhaseRef = useRef<MotionPhase>("idle");
  const setTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const weightOptions = unit === "kg" ? KG_WEIGHTS : LB_WEIGHTS;
  const selectedWeight = weightOptions[weightIndex] ?? weightOptions[0];
  const selectedMachineName = selectedMachine?.machineName ?? "";
  const selectedPart = selectedMachine?.targets ?? "";
  const allSetCounts = count > 0 ? [...completedSetCounts, count] : completedSetCounts;
  const totalRepCount = allSetCounts.reduce((sum, setCount) => sum + setCount, 0);
  const latestRepDuration = repDurations.at(-1);
  const recentAverageLevel = useMemo(() => getRecentAverageLevel(repLevels), [repLevels]);
  const averageLevel = Math.min(recentAverageLevel + getLevelBonus(repLevels.length), 3);
  const currentLevelLabel = useMemo(() => `Session Level ${currentLevel}`, [currentLevel]);
  const countAreaColorLevel = Math.min(
    Math.max(currentLevel + (repLevels.length >= 12 ? 2 : repLevels.length >= 8 ? 1 : 0), 1),
    5,
  );
  const tabs: { key: AppTab; label: string }[] = [
    { key: "home", label: "ホーム" },
    { key: "measure", label: "計測" },
    { key: "data", label: "データ" },
    { key: "analysis", label: "分析" },
  ];

  const analysisRows = useMemo<AnalysisRow[]>(() => {
    const grouped = records.reduce<Record<string, AnalysisRow>>((accumulator, record) => {
      const machine = record.machine_name || "マシン未設定";
      if (!accumulator[machine]) {
        accumulator[machine] = { machine, total: 0, sessions: 0 };
      }
      accumulator[machine].total += record.number_of_times ?? 0;
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

  const updateMotionPhase = useCallback((nextPhase: MotionPhase) => {
    motionPhaseRef.current = nextPhase;
    setMotionPhase(nextPhase);
  }, []);

  const clearMotionDetectionState = useCallback(() => {
    lastRepTimeRef.current = null;
    pushStartTimeRef.current = null;
    pullStartTimeRef.current = null;
    pushDurationRef.current = 0;
    pullDurationRef.current = 0;
    updateMotionPhase("idle");
  }, [updateMotionPhase]);

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
      clearMotionDetectionState();
      setTimerRef.current = null;
    }, SET_IDLE_MS);
  }, [clearMotionDetectionState, clearSetTimer]);

  const resetRuntimeRefs = useCallback(() => {
    baselineRef.current = null;
    smoothedSignalRef.current = 0;
    clearMotionDetectionState();
    clearSetTimer();
  }, [clearMotionDetectionState, clearSetTimer]);

  const stopMeasurement = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    setIsStopped(true);
    clearSetTimer();
  }, [clearSetTimer]);

  const resetMeasurement = useCallback(() => {
    stopMeasurement();
    resetRuntimeRefs();
    setCount(0);
    setCompletedSetCounts([]);
    setIsStopped(false);
    setWaveformData([]);
    setRepDurations([]);
    setRepLevels([]);
    setCurrentLevel(1);
    setLatestRepLevel(1);
    setSaveStatus("");
  }, [resetRuntimeRefs, stopMeasurement]);

  const resetAfterSuccessfulSave = useCallback(() => {
    resetMeasurement();
    setErrorMessage("");
  }, [resetMeasurement]);

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

  const completeRep = useCallback(
    (now: number) => {
      const pushDuration = pushDurationRef.current;
      const pullDuration = pullDurationRef.current;

      if (pushDuration < MIN_PUSH_DURATION_MS || pullDuration < MIN_PHASE_DURATION_MS) {
        clearMotionDetectionState();
        return;
      }

      const previousRepTime = lastRepTimeRef.current;
      if (previousRepTime !== null && now - previousRepTime < MIN_REP_INTERVAL_MS) {
        updateMotionPhase("cooldown");
        return;
      }

      const repDuration = (pushDuration + pullDuration) / 1000;
      const pushDurationSeconds = pushDuration / 1000;
      const pullDurationSeconds = pullDuration / 1000;
      const eccentricRatio = pullDurationSeconds / repDuration;
      if (!Number.isFinite(eccentricRatio)) {
        clearMotionDetectionState();
        return;
      }

      const repLevel = getRepLevel(repDuration, eccentricRatio);
      lastRepTimeRef.current = now;
      setCount((currentCount) => currentCount + 1);
      setRepDurations((currentDurations) => {
        const nextLevels = [...repLevels, repLevel];
        const nextAverageLevel = Math.min(getRecentAverageLevel(nextLevels) + getLevelBonus(nextLevels.length), 3);

        return [
          ...currentDurations,
          {
            pushDuration: pushDurationSeconds,
            pullDuration: pullDurationSeconds,
            repDuration,
            eccentricRatio,
            averageLevel: nextAverageLevel,
            level: repLevel,
          },
        ];
      });
      setLatestRepLevel(repLevel);
      setRepLevels((currentLevels) => {
        const nextLevels = [...currentLevels, repLevel];
        setCurrentLevel(getSessionLevelFromAverage(getRecentAverageLevel(nextLevels) + getLevelBonus(nextLevels.length)));
        return nextLevels;
      });
      updateMotionPhase("cooldown");
      pushStartTimeRef.current = null;
      pullStartTimeRef.current = null;
      pushDurationRef.current = 0;
      pullDurationRef.current = 0;
      armSetTimer();
    },
    [armSetTimer, clearMotionDetectionState, repLevels, updateMotionPhase],
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
      setWaveformData((currentData) => [...currentData.slice(-(WAVEFORM_MAX_POINTS - 1)), smoothedSignal]);

      const now = performance.now();
      const currentPhase = motionPhaseRef.current;

      if (currentPhase === "cooldown") {
        if (lastRepTimeRef.current !== null && now - lastRepTimeRef.current < MIN_REP_INTERVAL_MS) return;
        updateMotionPhase("idle");
      }

      if (motionPhaseRef.current === "idle") {
        if (smoothedSignal > PEAK_THRESHOLD) {
          pushStartTimeRef.current = now;
          updateMotionPhase("push");
        }
        return;
      }

      if (motionPhaseRef.current === "push") {
        if (smoothedSignal < -PEAK_THRESHOLD) {
          const pushStartTime = pushStartTimeRef.current;
          if (pushStartTime === null) {
            clearMotionDetectionState();
            return;
          }

          const pushDuration = now - pushStartTime;
          if (pushDuration < MIN_PHASE_DURATION_MS) {
            clearMotionDetectionState();
            return;
          }

          pushDurationRef.current = pushDuration;
          pullStartTimeRef.current = now;
          updateMotionPhase("pull");
        } else if (Math.abs(smoothedSignal) < RELEASE_THRESHOLD && pushStartTimeRef.current !== null) {
          const pushDuration = now - pushStartTimeRef.current;
          if (pushDuration < MIN_PHASE_DURATION_MS) {
            clearMotionDetectionState();
          }
        }
        return;
      }

      if (motionPhaseRef.current === "pull") {
        if (smoothedSignal > -RELEASE_THRESHOLD) {
          const pullStartTime = pullStartTimeRef.current;
          if (pullStartTime === null) {
            clearMotionDetectionState();
            return;
          }

          pullDurationRef.current = now - pullStartTime;
          completeRep(now);
        }
      }
    },
    [clearMotionDetectionState, completeRep, updateMotionPhase],
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

      setShowCompletionModal(false);
      resetMeasurement();
      setIsStopped(false);
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
        selectedMachineName,
        setCount: allSetCounts.length,
        weight: String(Math.round(selectedWeight)),
        count: totalRepCount,
        selectedPart,
      });
      console.log("Supabase insert payload:", payload);
      setIsSaving(true);
      const data = await saveKintoteRecord(payload);
      console.log("Supabase保存成功:", data);
      resetAfterSuccessfulSave();
      setShowCompletionModal(true);
      await loadHistory();
    } catch (error) {
      console.error("Supabase保存エラー:", error);
      setSaveStatus(parseKintoteErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  }, [allSetCounts.length, loadHistory, resetAfterSuccessfulSave, selectedMachineName, selectedPart, selectedWeight, totalRepCount]);

  const handleStopMeasurement = useCallback(() => {
    stopMeasurement();
  }, [stopMeasurement]);

  const handleCompletionHome = useCallback(() => {
    setShowCompletionModal(false);
    setActiveTab("home");
  }, []);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(Math.floor(rect.width * pixelRatio), 1);
    const height = Math.max(Math.floor(rect.height * pixelRatio), 1);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.clearRect(0, 0, width, height);
    if (waveformData.length < 2) return;

    const maxAmplitude = Math.max(...waveformData.map((value) => Math.abs(value)), PEAK_THRESHOLD, 1);
    const points = waveformData.map((value, index) => {
      const x = (index / (WAVEFORM_MAX_POINTS - 1)) * width;
      const normalized = Math.max(Math.min(value / maxAmplitude, 1), -1);
      const y = height / 2 - normalized * (height * 0.34);
      return { x, y };
    });

    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.lineTo(points[points.length - 1].x, height);
    context.lineTo(points[0].x, height);
    context.closePath();
    context.fillStyle = "rgba(255, 255, 255, 0.7)";
    context.fill();

    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
    context.strokeStyle = "#ffffff";
    context.lineWidth = 3 * pixelRatio;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
  }, [waveformData]);

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
                key={machine.machineName}
                onClick={() => handleSelectMachine(machine)}
              >
                <span>{machine.machineName}</span>
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
            <h1 id="measure-title" className={styles.measureTitle}>{selectedMachine?.machineName ?? "マシン未選択"}</h1>
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

          <section className={`${styles.measureArea} ${styles[`loadLevel${countAreaColorLevel}`]}`} aria-live="polite">
            <canvas ref={canvasRef} className={styles.waveformCanvas} aria-hidden="true" />
            <div className={styles.measureContent}>
              <div className={styles.statusRow}>
                <span className={isRunning ? styles.runningDot : styles.idleDot} />
                <span>{isRunning ? `計測中：${motionPhase}` : isStopped && totalRepCount > 0 ? "停止中" : "スタート待ち"}</span>
              </div>
              <p className={styles.setCount}>現在 {allSetCounts.length || 1}セット目</p>
              <div className={styles.countNumber}>{count}</div>
              <p className={styles.loadLabel}>{currentLevelLabel}</p>
              <div className={styles.repMetrics} aria-label="最新repの指標">
                <span>最新rep：Level {latestRepLevel}</span>
                <span>repDuration：{latestRepDuration ? formatSeconds(latestRepDuration.repDuration) : "--"}</span>
                <span>eccentricRatio：{latestRepDuration ? formatRatio(latestRepDuration.eccentricRatio) : "--"}</span>
                <span>直近5rep平均：{formatRatio(recentAverageLevel)}</span>
              </div>
              <div className={styles.debugMetrics} aria-label="デバッグ指標">
                <span>pushDuration: {latestRepDuration ? formatSeconds(latestRepDuration.pushDuration) : "--"}</span>
                <span>pullDuration: {latestRepDuration ? formatSeconds(latestRepDuration.pullDuration) : "--"}</span>
                <span>repDuration: {latestRepDuration ? formatSeconds(latestRepDuration.repDuration) : "--"}</span>
                <span>eccentricRatio: {latestRepDuration ? formatRatio(latestRepDuration.eccentricRatio) : "--"}</span>
                <span>averageLevel: {formatRatio(averageLevel)}</span>
              </div>
            </div>
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
              onClick={isRunning ? handleStopMeasurement : startMeasurement}
              disabled={!selectedMachine}
            >
              {isRunning ? "ストップ" : "スタート"}
            </button>
            {isStopped && totalRepCount > 0 && (
              <button className={styles.saveButton} type="button" onClick={handleSaveMeasurement} disabled={isSaving || !selectedMachine}>
                {isSaving ? "保存中..." : "保存"}
              </button>
            )}
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
              <article className={styles.historyCard} key={`${record.id}-${record.created_at ?? "no-date"}`}>
                <div>
                  <p className={styles.historyParts}>{record.machine_name || "マシン未設定"}</p>
                  <p className={styles.historyMeta}>{record.part || "部位未入力"} ・ {record.number_of_set ?? 0}セット</p>
                  <p className={styles.historyMeta}>ID: {record.id} ・ {formatDate(record.created_at)}</p>
                </div>
                <div className={styles.historyNumbers}>
                  <span>{record.number_of_times ?? 0}回</span>
                  <small>{record.weight === null ? "重量なし" : `${record.weight}kg`}</small>
                </div>
              </article>
            ))}
            {!records.length && <p className={styles.emptyState}>保存したデータがここに羅列されます。</p>}
          </div>
        </section>
      )}

      {showCompletionModal && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="completion-title">
          <div className={styles.completionModal}>
            <h2 id="completion-title">お疲れ様でした🎉</h2>
            <p>保存しました</p>
            <button className={styles.modalButton} type="button" onClick={handleCompletionHome}>
              器具を選択する
            </button>
          </div>
        </div>
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
