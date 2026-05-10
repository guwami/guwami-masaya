export type KintoteRecord = {
  id: number;
  machine_name: string | null;
  number_of_set: number | null;
  weight: number | null;
  created_at: string | null;
  number_of_times: number | null;
  part: string | null;
};

export type KintotePayload = {
  machine_name: string;
  number_of_set: number;
  weight: number;
  number_of_times: number;
  part: string;
};

type SupabaseErrorResponse = {
  message?: string;
  code?: string;
};

export class KintoteApiError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "KintoteApiError";
    this.code = code;
  }
}

export const SUPABASE_URL = "https://uwvkltzkchwqjqznzutg.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_keeDzP21zdl7Q79b2DVx7A_tg7UFt12";
export const SUPABASE_REST_URL = `${SUPABASE_URL}/rest/v1`;

const INT2_MIN = -32768;
const INT2_MAX = 32767;

export function getConfiguredSupabaseKey() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.SUPABASE_ANON_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? SUPABASE_PUBLISHABLE_KEY
  );
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

export function parseKintoteErrorMessage(error: unknown) {
  if (error instanceof KintoteApiError) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "保存に失敗しました。";
}

export function createKintotePayload(input: {
  selectedMachineName: string;
  setCount: number;
  weight: number | string;
  count: number;
  selectedPart: string;
}): KintotePayload {
  const selectedMachineName = input.selectedMachineName.trim();
  const selectedPart = input.selectedPart.trim();

  return {
    machine_name: selectedMachineName,
    number_of_set: Number(input.setCount),
    weight: Number(input.weight),
    number_of_times: Number(input.count),
    part: selectedPart,
  };
}

export function validateKintotePayload(input: {
  selectedMachineName: string;
  setCount: number;
  weight: string;
  count: number;
  selectedPart: string;
}): KintotePayload {
  const payload = createKintotePayload(input);

  if (!payload.machine_name) {
    throw new Error("マシン名を入力してください。");
  }

  if (!payload.part) {
    throw new Error("部位を入力してください。");
  }

  if (!Number.isInteger(payload.number_of_set) || payload.number_of_set < 0 || payload.number_of_set > INT2_MAX) {
    throw new Error(`セット数は0〜${INT2_MAX}の範囲で保存してください。`);
  }

  if (!Number.isInteger(payload.number_of_times) || payload.number_of_times < 0 || payload.number_of_times > INT2_MAX) {
    throw new Error(`回数は0〜${INT2_MAX}の範囲で保存してください。`);
  }

  payload.weight = parseIntegerField(String(input.weight), "重量", INT2_MIN, INT2_MAX);

  return payload;
}

export function sanitizeKintotePayload(payload: Partial<KintotePayload>): KintotePayload {
  return {
    machine_name: String(payload.machine_name ?? ""),
    number_of_set: Number(payload.number_of_set ?? 0),
    weight: Number(payload.weight ?? 0),
    number_of_times: Number(payload.number_of_times ?? 0),
    part: String(payload.part ?? ""),
  };
}

async function parseApiErrorResponse(response: Response) {
  const responseText = await response.text();
  if (!responseText) {
    return { message: `Supabase API エラー: ${response.status}` } satisfies SupabaseErrorResponse;
  }

  try {
    const parsedResponse = JSON.parse(responseText) as SupabaseErrorResponse;
    return {
      message: parsedResponse.message || responseText,
      code: parsedResponse.code,
    } satisfies SupabaseErrorResponse;
  } catch {
    return { message: responseText } satisfies SupabaseErrorResponse;
  }
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
    const apiError = await parseApiErrorResponse(response);
    throw new KintoteApiError(apiError.message || `Supabase API エラー: ${response.status}`, apiError.code);
  }

  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

async function requestKintoteApi<T>(init?: RequestInit) {
  const response = await fetch("/api/kintote", init);
  if (!response.ok) {
    const apiError = await parseApiErrorResponse(response);
    throw new KintoteApiError(apiError.message || `アプリAPIエラー: ${response.status}`, apiError.code);
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
