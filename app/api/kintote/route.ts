import { NextResponse } from "next/server";
import {
  getConfiguredSupabaseKey,
  requestSupabaseKintote,
  type KintotePayload,
  type KintoteRecord,
} from "../../../lib/supabaseKintote";

export async function GET() {
  try {
    const params = new URLSearchParams({
      select: "name,parts,number,weight,created_at",
      order: "created_at.desc",
      limit: "100",
    });
    const records = await requestSupabaseKintote<KintoteRecord[]>(`/kintote?${params.toString()}`, getConfiguredSupabaseKey());
    return NextResponse.json(records);
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "履歴の読み込みに失敗しました。", { status: 500 });
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
    return new NextResponse(error instanceof Error ? error.message : "保存に失敗しました。", { status: 500 });
  }
}
