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

export const SUPABASE_URL = "https://uwvkltzkchwqjqznzutg.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_keeDzP21zdl7Q79b2DVx7A_tg7UFt12";
export const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

const INT2_MIN = -32768;
const INT2_MAX = 32767;
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

export function getConfiguredSupabaseKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.SUPABASE_ANON_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? SUPABASE_PUBLISHABLE_KEY
  );
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

export async function requestSupabaseKintote<T>(path: string, anonKey: string, init?: RequestInit) {
  const trimmedKey = anonKey.trim();
  if (!trimmedKey) {
    throw new Error("Supabase publishable key が設定されていません。");
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

async function requestKintoteApi<T>(init?: RequestInit) {
  const response = await fetch("/api/kintote", init);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `アプリAPIエラー: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function saveKintoteRecord(payload: KintotePayload) {
  return requestKintoteApi<KintoteRecord[]>({
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function fetchKintoteHistory() {
  return requestKintoteApi<KintoteRecord[]>();
}
