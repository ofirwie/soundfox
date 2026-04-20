import { NextRequest, NextResponse } from "next/server";
import { appendFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join(process.cwd(), "soundfox-debug.log");

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ts = new Date().toISOString();
  let body: unknown = null;
  let raw = "";
  try {
    raw = await request.text();
    body = raw ? JSON.parse(raw) : { _empty: true };
  } catch (e) {
    body = { _parse_error: String(e), raw };
  }
  const line = `[${ts}] ${typeof body === "string" ? body : JSON.stringify(body)}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch (e) {
    return NextResponse.json({ error: "write_failed", detail: String(e), path: LOG_FILE }, { status: 500 });
  }
  // Also echo to dev server stdout
  console.log("[/api/log]", line.trim());
  return NextResponse.json({ ok: true, written: line.length });
}
