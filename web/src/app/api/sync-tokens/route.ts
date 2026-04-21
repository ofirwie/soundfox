import { NextRequest, NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ENV_FILE = join(process.cwd(), ".env");

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json() as {
    access_token?: string;
    refresh_token?: string;
    expiry?: string;
    client_id?: string;
  };

  if (!body.access_token || !body.client_id) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }

  let env = "";
  try { env = readFileSync(ENV_FILE, "utf-8"); } catch { env = ""; }

  function setVar(content: string, key: string, value: string): string {
    const re = new RegExp(`^${key}=.*$`, "m");
    return re.test(content) ? content.replace(re, `${key}=${value}`) : content + `\n${key}=${value}`;
  }

  env = setVar(env, "SPOTIFY_ACCESS_TOKEN", body.access_token);
  env = setVar(env, "SPOTIFY_CLIENT_ID", body.client_id);
  if (body.refresh_token) env = setVar(env, "SPOTIFY_REFRESH_TOKEN", body.refresh_token);
  if (body.expiry) env = setVar(env, "SPOTIFY_TOKEN_EXPIRY", body.expiry);

  writeFileSync(ENV_FILE, env);
  return NextResponse.json({ ok: true });
}
