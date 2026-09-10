import { NextResponse } from "next/server";
import { authorizeAdmin, listDraftsForAdmin } from "@/lib/admin";

export async function GET(req: Request) {
  if (!authorizeAdmin(req.headers.get("authorization")?.replace("Bearer ", "") ?? null)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  const rawTenant = new URL(req.url).searchParams.get("tenantId");
  if (rawTenant === null || !/^\d+$/.test(rawTenant)) return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
  const tenantId = Number(rawTenant);
  return NextResponse.json({ data: await listDraftsForAdmin(tenantId) });
}