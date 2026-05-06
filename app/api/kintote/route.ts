import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_REST_URL, type KintotePayload, type KintoteRecord } from "../../../lib/supabaseKintote";

function getSupabaseApiKey() {
  return process.env.SUPABASE_API_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";
}

function createErrorResponse(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

function isKintotePayload(value: unknown): value is KintotePayload {
  if (!value || typeof value !== "object") return false;

  const payload = value as Partial<KintotePayload>;
  return (
    Number.isInteger(payload.name) &&
    typeof payload.parts === "string" &&
    Number.isInteger(payload.number) &&
    (payload.weight === null || Number.isInteger(payload.weight)) &&
    typeof payload.created_at === "string"
  );
}

async function requestSupabase<T>(path: string, init?: RequestInit) {
  const apiKey = getSupabaseApiKey();
  if (!apiKey) {
    throw new Error("SUPABASE_API_KEY が未設定です。サーバーの環境変数に Supabase API key を設定してください。");
  }

  const response = await fetch(`${SUPABASE_REST_URL}${path}`, {
    cache: "no-store",
    ...init,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Supabase API エラー: ${response.status}`);
  }

  return (await response.json()) as T;
}

export async function GET() {
  try {
    const params = new URLSearchParams({
      select: "name,parts,number,weight,created_at",
      order: "created_at.desc",
      limit: "100",
    });
    const data = await requestSupabase<KintoteRecord[]>(`/kintote?${params.toString()}`);
    return NextResponse.json({ data });
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : "履歴の読み込みに失敗しました。");
  }
}

export async function POST(request: NextRequest) {
  try {
    const payload: unknown = await request.json();
    if (!isKintotePayload(payload)) {
      return createErrorResponse("保存データの形式が正しくありません。", 400);
    }

    const data = await requestSupabase<KintoteRecord[]>("/kintote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    return NextResponse.json({ data });
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : "保存に失敗しました。");
  }
}
