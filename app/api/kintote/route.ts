import { NextResponse } from "next/server";
import {
  getConfiguredSupabaseKey,
  KintoteApiError,
  requestSupabaseKintote,
  type KintotePayload,
  type KintoteRecord,
} from "../../../lib/supabaseKintote";

function kintoteErrorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof KintoteApiError) {
    return NextResponse.json({ message: error.message, code: error.code }, { status: 500 });
  }

  return NextResponse.json({ message: error instanceof Error ? error.message : fallbackMessage }, { status: 500 });
}

export async function GET() {
  try {
    const params = new URLSearchParams({
      select: 'id,"Machine Name","number of set",weight,created_at,"Number of times",part',
      order: "created_at.desc",
      limit: "100",
    });
    const records = await requestSupabaseKintote<KintoteRecord[]>(`/kintote?${params.toString()}`, getConfiguredSupabaseKey());
    return NextResponse.json(records);
  } catch (error) {
    return kintoteErrorResponse(error, "履歴の読み込みに失敗しました。");
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as KintotePayload;
    const records = await requestSupabaseKintote<KintoteRecord[]>("/kintote", getConfiguredSupabaseKey(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });
    return NextResponse.json(records);
  } catch (error) {
    return kintoteErrorResponse(error, "保存に失敗しました。");
  }
}
