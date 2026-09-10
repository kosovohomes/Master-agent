import { NextResponse } from "next/server";
import { getWidgetConfig, UnknownTenantError } from "@/lib/widget";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tenant = url.searchParams.get("tenant");
  if (!tenant) return NextResponse.json({ errors: [{ code: "MISSING_TENANT" }] }, { status: 400 });
  try {
    const cfg = await getWidgetConfig(tenant);
    return NextResponse.json({ data: cfg, meta: { ts: new Date().toISOString() } });
  } catch (e) {
    if (e instanceof UnknownTenantError) {
      return NextResponse.json({ errors: [{ code: "UNKNOWN_TENANT" }] }, { status: 404 });
    }
    return NextResponse.json({ errors: [{ code: "CONFIG_UNAVAILABLE", detail: "internal error" }] }, { status: 500 });
  }
}