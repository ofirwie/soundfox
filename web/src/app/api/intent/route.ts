import { NextRequest, NextResponse } from "next/server";
import { parseIntent } from "@/lib/gemini-server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { freeText, playlistContext } = body;
    if (!freeText || !playlistContext) {
      return NextResponse.json({ error: "freeText and playlistContext required" }, { status: 400 });
    }
    const intent = await parseIntent(freeText, playlistContext);
    return NextResponse.json({ intent });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
