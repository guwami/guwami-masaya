"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSessionId,
  saveKintoteRecord,
  validateKintotePayload,
} from "../lib/supabaseKintote";
import styles from "./page.module.css";

type SensorPermission = "unknown" | "granted" | "denied" | "unsupported";
type PeakDirection = "up" | "down";
type Unit = "kg" | "lb";
type LoadLevel = 1 | 2 | 3 | 4 | 5;

type MotionPermissionEvent = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type Machine = {
  name: string;
  targets: string;
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
const PEAK_THRESHOLD = 1.6;
const RELEASE_THRESHOLD = 0.65;
const MIN_REP_INTERVAL_MS = 450;
const SET_IDLE_MS = 15_000;
const MICRO_MOVEMENT_THRESHOLD = 0.55;
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

export default function Home() {
  const [selectedMachine, setSelectedMachine] = useState<Machine | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [setsCompleted, setSetsCompleted] = useState(0);
  const [continuousCount, setContinuousCount] = useState(0);
  const [sensorPermission, setSensorPermission] = useState<SensorPermission>("unknown");
  const [errorMessage, setErrorMessage] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [weightIndex, setWeightIndex] = useState(8);
  const [unit, setUnit] = useState<Unit>("kg");
  const [loadLevel, setLoadLevel] = useState<LoadLevel>(1);
  const [accelerationScore, setAccelerationScore] = useState(1);
  const [countScore, setCountScore] = useState(1);
  const [accelerationRatio, setAccelerationRatio] = useState(0);
  const [loadScore, setLoadScore] = useState(1);
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);

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

  const loadLevelLabel = useMemo(() => `レベル${loadLevel}`, [loadLevel]);

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
      setSetsCompleted((current) => current + 1);
      setContinuousCount(0);
      setCountScore(1);
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
    setSetsCompleted(0);
    setContinuousCount(0);
    setLoadLevel(1);
    setAccelerationScore(1);
    setCountScore(1);
    setAccelerationRatio(0);
    setLoadScore(1);
    setSaveStatus("");
  }, [resetRuntimeRefs, stopMeasurement]);

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
      const { ratio, score: nextAccelerationScore } = getAccelerationScore(
        currentUpPeakRef.current,
        currentDownPeakRef.current,
      );

      setCount((currentCount) => currentCount + 1);
      setContinuousCount((currentContinuousCount) => {
        const nextContinuousCount = currentContinuousCount + 1;
        const nextCountScore = getCountScore(nextContinuousCount);
        const nextLoadScore = nextAccelerationScore * nextCountScore;

        setCountScore(nextCountScore);
        setLoadScore(nextLoadScore);
        setLoadLevel(getLoadLevel(nextLoadScore));
        return nextContinuousCount;
      });
      setAccelerationRatio(ratio);
      setAccelerationScore(nextAccelerationScore);
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
  }, [resetMeasurement]);

  const handleSaveMeasurement = useCallback(async () => {
    setSaveStatus("");

    try {
      const payload = validateKintotePayload({
        sessionId,
        parts: machineParts,
        count,
        weight: String(Math.round(selectedWeight)),
      });
      setIsSaving(true);
      await saveKintoteRecord(payload);
      setSaveStatus("Supabaseに保存しました。履歴ページで確認できます。");
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "保存に失敗しました。");
    } finally {
      setIsSaving(false);
    }
  }, [count, machineParts, selectedWeight, sessionId]);

  const handleSelectMachine = useCallback((machine: Machine) => {
    setSelectedMachine(machine);
    resetMeasurement();
  }, [resetMeasurement]);

  const handleBackHome = useCallback(() => {
    resetMeasurement();
    setSelectedMachine(null);
  }, [resetMeasurement]);

  useEffect(() => {
    setSessionId(String(createSessionId()));
  }, []);

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

  if (!selectedMachine) {
    return (
      <main className={styles.appShell}>
        <section className={styles.hero} aria-labelledby="app-title">
          <p className={styles.kicker}>Machine Select</p>
          <h1 id="app-title" className={styles.title}>ホーム</h1>
          <p className={styles.description}>筋トレのマシンを選択してください。選択すると計測画面へ移動します。</p>
        </section>

        <nav className={styles.navLinks} aria-label="ページ移動">
          <Link href="/history">計測履歴を見る</Link>
        </nav>

        <section className={styles.machineGrid} aria-label="筋トレマシン一覧">
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
        </section>
      </main>
    );
  }

  return (
    <main className={styles.appShell}>
      <section className={styles.measureHeader} aria-labelledby="measure-title">
        <button className={styles.backButton} type="button" onClick={handleBackHome}>ホームへ</button>
        <p className={styles.kicker}>Measurement</p>
        <h1 id="measure-title" className={styles.title}>{selectedMachine.name}</h1>
        <p className={styles.description}>{selectedMachine.targets}</p>
      </section>

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
          <span>{isRunning ? "計測中" : count > 0 ? "停止中" : "スタート待ち"}</span>
        </div>
        <p className={styles.setCount}>セット {setsCompleted}</p>
        <div className={styles.countNumber}>{count}</div>
        <p className={styles.loadLabel}>{loadLevelLabel}</p>
        <div className={styles.loadDetails}>
          <span>加速度 {accelerationScore}（下/上 {accelerationRatio.toFixed(0)}%）</span>
          <span>連続回数 {continuousCount} → {countScore}</span>
          <span>負荷 {accelerationScore} × {countScore} = {loadScore}</span>
        </div>
      </section>

      <section className={styles.actionArea} aria-label="操作エリア">
        <button
          className={isRunning ? styles.stopButtonInline : styles.startButton}
          type="button"
          onClick={isRunning ? stopMeasurement : startMeasurement}
        >
          {isRunning ? "ストップ" : "スタート"}
        </button>
        <button className={styles.saveButton} type="button" onClick={handleSaveMeasurement} disabled={isSaving || count === 0}>
          {isSaving ? "保存中..." : "保存"}
        </button>
        {saveStatus && <p className={styles.saveStatus}>{saveStatus}</p>}
      </section>
    </main>
  );
}
