import { NextResponse } from "next/server";
import { authorizeAdmin, listDraftsForAdmin } from "@/lib/admin";

export async function GET(req: Request) {
  if (!authorizeAdmin(req.headers.get("authorization")?.replace("Bearer ", "") ?? null)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  const rawTenant = new URL(req.url).searchParams.get("tenantId");
  const tenantId = rawTenant === null ? Number.NaN : Number(rawTenant);
  if (!Number.isInteger(tenantId)) return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
  return NextResponse.json({ data: await listDraftsForAdmin(tenantId) });
}