import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/security";

export async function POST(req: Request) {
  const { password } = (await req.json()) as { password?: string };
  if (!safeEqual(password ?? null, process.env.ADMIN_PASSWORD ?? null)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  return NextResponse.json({ data: { ok: true } });
}