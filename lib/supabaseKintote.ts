export type KintoteRecord = {
  name: number;
  parts: string | null;
  number: number;
  weight: number | null;
  created_at: string | null;
};

export type KintotePayload = {
  name: number;
  parts: string;
  number: number;
  weight: number | null;
  created_at: string;
};

export const SUPABASE_REST_URL = "https://uwvkltzkchwqjqznzutg.supabase.co/rest/v1";

const INT2_MIN = -32768;
const INT2_MAX = 32767;
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

export function getInitialAnonKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
}

export function getStoredAnonKey() {
  if (typeof window === "undefined") return getInitialAnonKey();
  return window.localStorage.getItem("kintote_supabase_anon_key") ?? getInitialAnonKey();
}

export function storeAnonKey(anonKey: string) {
  if (typeof window === "undefined") return;
  const trimmedKey = anonKey.trim();
  if (trimmedKey) {
    window.localStorage.setItem("kintote_supabase_anon_key", trimmedKey);
  } else {
    window.localStorage.removeItem("kintote_supabase_anon_key");
  }
}

export function createSessionId() {
  const randomValue = Math.floor(Math.random() * 900_000);
  const seconds = Math.floor(Date.now() / 1000) % 2_000_000_000;
  return Math.min(INT4_MAX, seconds + randomValue);
}

export function parseIntegerField(value: string, fieldName: string, min: number, max: number) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error(`${fieldName}を入力してください。`);
  }

  const parsedValue = Number(trimmedValue);
  if (!Number.isInteger(parsedValue) || parsedValue < min || parsedValue > max) {
    throw new Error(`${fieldName}は${min}〜${max}の整数で入力してください。`);
  }

  return parsedValue;
}

export function parseOptionalIntegerField(value: string, fieldName: string, min: number, max: number) {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;
  return parseIntegerField(trimmedValue, fieldName, min, max);
}

export function validateKintotePayload(input: {
  sessionId: string;
  parts: string;
  count: number;
  weight: string;
}): KintotePayload {
  if (!input.parts.trim()) {
    throw new Error("部位を入力してください。");
  }

  if (!Number.isInteger(input.count) || input.count < 0 || input.count > INT2_MAX) {
    throw new Error(`回数は0〜${INT2_MAX}の範囲で保存してください。`);
  }

  return {
    name: parseIntegerField(input.sessionId, "記録ID", INT4_MIN, INT4_MAX),
    parts: input.parts.trim(),
    number: input.count,
    weight: parseOptionalIntegerField(input.weight, "重量", INT2_MIN, INT2_MAX),
    created_at: new Date().toISOString(),
  };
}

async function requestKintote<T>(path: string, anonKey: string, init?: RequestInit) {
  const trimmedKey = anonKey.trim();
  if (!trimmedKey) {
    throw new Error("Supabase anon key が未設定です。画面の入力欄に anon key を入力してください。");
  }

  const response = await fetch(`${SUPABASE_REST_URL}${path}`, {
    ...init,
    headers: {
      apikey: trimmedKey,
      Authorization: `Bearer ${trimmedKey}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Supabase API エラー: ${response.status}`);
  }

  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

export async function saveKintoteRecord(payload: KintotePayload, anonKey: string) {
  return requestKintote<KintoteRecord[]>("/kintote", anonKey, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });
}

export async function fetchKintoteHistory(anonKey: string) {
  const params = new URLSearchParams({
    select: "name,parts,number,weight,created_at",
    order: "created_at.desc",
    limit: "100",
  });
  return requestKintote<KintoteRecord[]>(`/kintote?${params.toString()}`, anonKey);
}
