import { NextRequest, NextResponse } from "next/server";
import { generateRecommendations } from "@/lib/gemini-server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    if (!body.intent || !body.tasteVector || !body.topArtists) {
      return NextResponse.json({ error: "intent, tasteVector, topArtists required" }, { status: 400 });
    }
    const recommendations = await generateRecommendations({
      intent: body.intent,
      tasteVector: body.tasteVector,
      topArtists: body.topArtists,
      sampleTracks: body.sampleTracks ?? [],
      count: body.count ?? 40,
      excludeArtists: body.excludeArtists ?? [],
    });
    return NextResponse.json({ recommendations });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
