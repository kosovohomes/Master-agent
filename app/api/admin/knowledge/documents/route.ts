import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { hybridRetrieveDetailed } from "@/lib/knowledge/retrieve";
import { ai } from "@/lib/ai";
import { isFlagEnabled } from "@/lib/settings";
import { query } from "@/lib/db";
import { requestIdFor } from "@/lib/audit";
import type { KnowledgeScope } from "@/lib/knowledge/types";

export const runtime = "nodejs";

/**
 * /api/admin/knowledge/documents (Phase 5 — knowledge admin read APIs).
 *
 * GET with `?query=` — hybrid retrieval playground: admin can probe exactly
 * what a scoped caller would see (GLOBAL/BU/WEBSITE/JURISDICTION/AGENT),
 * with every citation carrying tier + provenance. Admin mode is `unrestricted`
 * only when the caller omits businessUnitId (see everything); passing a BU
 * previews that BU's view. publicOnly previews the anonymous widget caller.
 *
 * GET without query — recent documents browse (scope columns, tier, access,
 * verification status, chunk counts).
 *
 * knowledge.manage / audit.read; llm.view is NOT required — retrieval
 * embeddings ride the gateway and are ledgered against no BU.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["knowledge.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get("query") ?? "").trim();
  const num = (key: string): number | null => {
    const raw = url.searchParams.get(key);
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const businessUnitId = num("businessUnitId");
  const websiteId = num("websiteId");
  const topK = num("topK") ?? 8;

  if (q !== "") {
    const flag = await isFlagEnabled("knowledge_v2", false);
    const scope: KnowledgeScope = {
      businessUnitId,
      websiteId,
      jurisdiction: url.searchParams.get("jurisdiction"),
      language: url.searchParams.get("language"),
      agentSlug: url.searchParams.get("agentSlug") || null,
      maxAuthorityTier: num("maxAuthorityTier") ?? 5,
      publicOnly: url.searchParams.get("publicOnly") === "1",
      // Admin sees the whole corpus only when previewing without a BU;
      // with a BU set the playground reproduces that BU's exact view.
      unrestricted: businessUnitId == null,
    };
    if (!flag) {
      return NextResponse.json(
        { errors: [{ code: "KNOWLEDGE_V2_DISABLED", detail: "enable the knowledge_v2 flag to use hybrid retrieval" }] },
        { status: 409 }
      );
    }
    const { citations, legs } = await hybridRetrieveDetailed(ai, { scope, query: q, topK });
    return NextResponse.json({ data: { query: q, scope, legs, citations }, meta: { requestId } });
  }

  const limit = Math.min(200, num("limit") ?? 50);
  const rows = await query<any>(
    `SELECT d.id, d.title, d.url, d.checksum, d.created_at,
            d.business_unit_id, d.website_id, d.knowledge_source_id,
            d.jurisdiction, d.country, d.language, d.document_type,
            d.access_level, d.authority_tier, d.verification_status,
            d.effective_date::text AS effective_date, d.source_url,
            (SELECT count(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunk_count,
            ks.title AS source_title
     FROM documents d
     LEFT JOIN knowledge_sources ks ON ks.id = d.knowledge_source_id
     WHERE ($1::bigint IS NULL OR d.business_unit_id = $1::bigint)
     ORDER BY d.id DESC
     LIMIT $2`,
    [businessUnitId, limit]
  );

  return NextResponse.json({
    data: {
      documents: rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        url: r.url,
        checksum: r.checksum,
        createdAt: r.created_at,
        businessUnitId: r.business_unit_id,
        websiteId: r.website_id,
        knowledgeSourceId: r.knowledge_source_id,
        jurisdiction: r.jurisdiction,
        country: r.country,
        language: r.language,
        documentType: r.document_type,
        accessLevel: r.access_level,
        authorityTier: r.authority_tier,
        verificationStatus: r.verification_status,
        effectiveDate: r.effective_date,
        sourceUrl: r.source_url,
        chunkCount: r.chunk_count,
        sourceTitle: r.source_title,
      })),
    },
    meta: { requestId },
  });
}
