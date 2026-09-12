import { query } from "../db";
import crypto from "node:crypto";

export type Context = { embed(texts: string[]): Promise<number[][]> };

const CHUNK_SIZE = 800;

function chunkText(text: string): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > 0) {
    out.push(rest.slice(0, CHUNK_SIZE));
    rest = rest.slice(CHUNK_SIZE);
  }
  return out.length > 0 ? out : [""];
}

export async function addContentSource(ctx: Context, p: {
  tenantId: number; kind: "sitemap" | "upload" | "api"; ref: string;
}) {
  const rows = await query<{ id: number }>(
    `INSERT INTO content_sources (tenant_id, kind, ref) VALUES ($1, $2, $3) RETURNING id`,
    [p.tenantId, p.kind, p.ref]
  );
  return { sourceId: rows[0].id };
}

export async function ingestText(ctx: Context, p: {
  tenantId: number; sourceId: number; title: string; url?: string; text: string;
}) {
  const checksum = crypto.createHash("sha256").update(p.text).digest("hex");
  const existing = await query<{ id: number }>(
    `SELECT id FROM documents WHERE tenant_id = $1 AND checksum = $2`,
    [p.tenantId, checksum]
  );
  if (existing.length > 0) {
    const [countRow] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chunks WHERE document_id = $1`,
      [existing[0].id]
    );
    return { documentId: existing[0].id, chunkCount: countRow.n };
  }

  const chunks = chunkText(p.text);
  const embeddings = await ctx.embed(chunks);
  if (embeddings.length !== chunks.length) {
    throw new Error(`embed returned ${embeddings.length} vector(s) for ${chunks.length} input(s)`);
  }

  // Phase 5: legacy-ingested documents are widget-visible by design, so the
  // v2 scope columns are stamped here too (public access + BU mapping) —
  // otherwise documents created after the M_024 backfill would be invisible
  // to the scoped public chat path. Legacy readers are unaffected.
  const docRows = await query<{ id: number }>(
    `INSERT INTO documents (tenant_id, source_id, title, url, checksum, access_level)
     VALUES ($1, $2, $3, $4, $5, 'public') RETURNING id`,
    [p.tenantId, p.sourceId, p.title, p.url ?? null, checksum]
  );
  const documentId = docRows[0].id;
  await query(
    `UPDATE documents d SET business_unit_id = bu.id
     FROM business_units bu
     WHERE bu.legacy_tenant_id = d.tenant_id AND d.id = $1`,
    [documentId]
  ).catch(() => undefined);
  for (let i = 0; i < chunks.length; i++) {
    await query(
      `INSERT INTO chunks (document_id, tenant_id, content, embedding, tsv)
       VALUES ($1, $2, $3, $4::vector, to_tsvector('english', $3))`,
      [documentId, p.tenantId, chunks[i], JSON.stringify(embeddings[i])]
    );
  }
  return { documentId, chunkCount: chunks.length };
}