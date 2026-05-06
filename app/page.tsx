"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

type SensorPermission = "unknown" | "granted" | "denied" | "unsupported";
type PeakDirection = "up" | "down";

type MotionPermissionEvent = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type RepRecord = {
  completedAt: number;
  durationMs: number | null;
};

const MAX_WAVEFORM_POINTS = 180;
const BASELINE_ALPHA = 0.02;
const SMOOTHING_ALPHA = 0.25;
const PEAK_THRESHOLD = 1.6;
const RELEASE_THRESHOLD = 0.65;
const MIN_REP_INTERVAL_MS = 450;
const WAVEFORM_STATE_INTERVAL_MS = 80;

export default function Home() {
  const [isRunning, setIsRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [sensorPermission, setSensorPermission] = useState<SensorPermission>("unknown");
  const [errorMessage, setErrorMessage] = useState("");
  const [waveformData, setWaveformData] = useState<number[]>([]);
  const [lastRepTime, setLastRepTime] = useState<number | null>(null);
  const [repDurations, setRepDurations] = useState<RepRecord[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const isRunningRef = useRef(false);
  const baselineRef = useRef<number | null>(null);
  const smoothedSignalRef = useRef(0);
  const armedPeaksRef = useRef<Record<PeakDirection, boolean>>({ up: true, down: true });
  const detectedPeaksRef = useRef<Set<PeakDirection>>(new Set());
  const lastRepTimeRef = useRef<number | null>(null);
  const waveformRef = useRef<number[]>([]);
  const lastWaveformStateUpdateRef = useRef(0);

  const resetRuntimeRefs = useCallback(() => {
    baselineRef.current = null;
    smoothedSignalRef.current = 0;
    armedPeaksRef.current = { up: true, down: true };
    detectedPeaksRef.current = new Set();
    lastRepTimeRef.current = null;
    waveformRef.current = [];
    lastWaveformStateUpdateRef.current = 0;
  }, []);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const rect = canvas.getBoundingClientRect();
    const devicePixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * devicePixelRatio));
    const height = Math.max(1, Math.floor(rect.height * devicePixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#091827";
    context.fillRect(0, 0, width, height);

    const midY = height / 2;
    context.strokeStyle = "rgba(255, 255, 255, 0.18)";
    context.lineWidth = 1 * devicePixelRatio;
    context.beginPath();
    context.moveTo(0, midY);
    context.lineTo(width, midY);
    context.stroke();

    context.strokeStyle = "rgba(56, 189, 248, 0.95)";
    context.lineWidth = 3 * devicePixelRatio;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();

    const data = waveformRef.current;
    const amplitudeScale = height / 7;
    data.forEach((value, index) => {
      const x = data.length <= 1 ? width : (index / (MAX_WAVEFORM_POINTS - 1)) * width;
      const y = midY - Math.max(-3.5, Math.min(3.5, value)) * amplitudeScale;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();

    if (isRunningRef.current) {
      animationRef.current = window.requestAnimationFrame(drawWaveform);
    }
  }, []);

  const stopMeasurement = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    if (animationRef.current !== null) {
      window.cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  }, []);

  const processPeak = useCallback((direction: PeakDirection, now: number) => {
    detectedPeaksRef.current.add(direction);

    if (!detectedPeaksRef.current.has("up") || !detectedPeaksRef.current.has("down")) {
      return;
    }

    const previousRepTime = lastRepTimeRef.current;
    if (previousRepTime !== null && now - previousRepTime < MIN_REP_INTERVAL_MS) {
      return;
    }

    const durationMs = previousRepTime === null ? null : now - previousRepTime;
    lastRepTimeRef.current = now;
    detectedPeaksRef.current = new Set();

    setCount((current) => current + 1);
    setLastRepTime(now);
    setRepDurations((current) => [...current, { completedAt: now, durationMs }]);
  }, []);

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

      const now = performance.now();
      waveformRef.current = [...waveformRef.current.slice(-(MAX_WAVEFORM_POINTS - 1)), smoothedSignal];

      if (now - lastWaveformStateUpdateRef.current > WAVEFORM_STATE_INTERVAL_MS) {
        setWaveformData(waveformRef.current);
        lastWaveformStateUpdateRef.current = now;
      }

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

      resetRuntimeRefs();
      setCount(0);
      setLastRepTime(null);
      setRepDurations([]);
      setWaveformData([]);
      isRunningRef.current = true;
      setIsRunning(true);
      animationRef.current = window.requestAnimationFrame(drawWaveform);
    } catch {
      setSensorPermission("denied");
      setErrorMessage("センサー権限のリクエスト中にエラーが発生しました。iOS SafariでHTTPS接続から開いてください。");
    }
  }, [drawWaveform, resetRuntimeRefs]);

  useEffect(() => {
    if (!isRunning) return;
    window.addEventListener("devicemotion", handleMotion);
    return () => window.removeEventListener("devicemotion", handleMotion);
  }, [handleMotion, isRunning]);

  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (animationRef.current !== null) {
        window.cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  const latestDuration = repDurations.at(-1)?.durationMs;

  return (
    <main className={styles.appShell}>
      <section className={styles.hero} aria-labelledby="app-title">
        <p className={styles.kicker}>iPhone Motion Counter</p>
        <h1 id="app-title" className={styles.title}>筋トレ往復カウンター</h1>
        <p className={styles.description}>画面を上向きにして、スマホを上下に1往復させるたびにカウントします。</p>
      </section>

      <section className={styles.counterCard} aria-live="polite">
        <div className={styles.statusRow}>
          <span className={isRunning ? styles.runningDot : styles.idleDot} />
          <span>{isRunning ? "計測中" : count > 0 ? "停止中" : "スタート待ち"}</span>
        </div>
        <div className={styles.countNumber}>{count}</div>
        <div className={styles.subInfo}>
          {latestDuration ? `直近1往復: ${(latestDuration / 1000).toFixed(2)}秒` : "距離は計測せず、上下の加速度ピークだけを検出します"}
        </div>
      </section>

      {errorMessage && <p className={styles.errorMessage} role="alert">{errorMessage}</p>}

      {!isRunning && (
        <button className={styles.startButton} type="button" onClick={startMeasurement}>
          スタート
        </button>
      )}

      <section className={styles.waveformSection} aria-label="z軸加速度の波形">
        <div className={styles.waveformHeader}>
          <span>z軸加速度 波形</span>
          <span>{isRunning ? `${waveformData.length} samples` : sensorPermission === "granted" ? "停止中" : "待機中"}</span>
        </div>
        <canvas ref={canvasRef} className={styles.waveformCanvas} />
      </section>

      <div className={styles.bottomSpacer} />

      <button className={styles.stopButton} type="button" onClick={stopMeasurement} disabled={!isRunning}>
        ストップ
      </button>
    </main>
  );
}
