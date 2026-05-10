import { NextResponse } from "next/server";
import {
  getConfiguredSupabaseKey,
  KintoteApiError,
  requestSupabaseKintote,
  sanitizeKintotePayload,
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
      select: "id,machine_name,number_of_set,weight,created_at,number_of_times,part",
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
    const requestPayload = (await request.json()) as Partial<KintotePayload>;
    const payload = sanitizeKintotePayload(requestPayload);
    console.log("Supabase insert payload:", payload);

    const params = new URLSearchParams({
      select: "id,machine_name,number_of_set,weight,created_at,number_of_times,part",
    });
    const records = await requestSupabaseKintote<KintoteRecord[]>(`/kintote?${params.toString()}`, getConfiguredSupabaseKey(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify([payload]),
    });
    return NextResponse.json(records);
  } catch (error) {
    console.error("Supabase保存エラー:", error);
    return kintoteErrorResponse(error, "保存に失敗しました。");
  }
}
