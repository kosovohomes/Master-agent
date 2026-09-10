import { query } from "./db";
import { llm } from "./llm";
import { addContentSource, ingestText } from "./rag/ingest";
import { dispatch, getTenantConfig } from "./agents/dispatch";

/** Editable defaults for the built-in demo tenant. */
export const DEMO_DEFAULTS = {
  slug: "acme-homes",
  name: "Acme Homes",
  brandVoice: "Warm, confident, plain-spoken. Short sentences. No hype words.",
  persona: "A trusted local home-builder who has delivered 500+ families their dream home.",
  audience: "First-time home buyers and young families in the Prishtina metro area.",
  knowledge: `
Acme Homes builds energy-efficient family homes in the Prishtina metro area.
Every home includes triple-glazed windows, a heat pump, and a 10-year structural
warranty. Our autumn collection starts at EUR 89,000 with move-in dates from
March 2027. We offer guided weekend viewings at our model village in Dragodan,
Saturdays and Sundays 10:00-16:00, no appointment needed. Buyers can reserve a
plot with a refundable EUR 500 deposit. We partner with three local banks to
offer mortgage pre-approval in under 48 hours. Our customer satisfaction score
for 2025 handovers was 4.8 out of 5 based on 214 reviews.
`,
  // NOTE: topic wording matters — the router is keyword-based.
  // Avoid "research", "outreach", "promote", "event" etc. unless you WANT a different agent.
  topic: "Announce our autumn collection of energy-efficient family homes starting at EUR 89,000",
  channel: "linkedin", // linkedin | x | email (instagram/tiktok are draft-only in v1)
};

export interface DemoSeedResult {
  tenantId: number;
  tenantSlug: string;
  documentId: number;
  chunkCount: number;
  runId: number;
  agent: string;
  routeReason: string;
  draft: { id: number; agent: string; channel: string; status: string; content: string };
}

/**
 * Idempotent end-to-end demo: tenant + brand config + RAG ingestion
 * (OpenAI embeddings -> pgvector) + a real LLM-generated pending draft.
 * Used by scripts/seed-demo.ts (CLI) and POST /api/admin/seed (ops endpoint).
 */
export async function runDemoSeed(
  p: Partial<Omit<typeof DEMO_DEFAULTS, "knowledge">> & { knowledge?: string } = {}
): Promise<DemoSeedResult> {
  const cfg = {
    ...DEMO_DEFAULTS,
    // strip explicit `undefined` values so they don't clobber the defaults
    ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
  };

  // 1. Tenant (upsert by slug)
  const [tenant] = await query<{ id: number; name: string }>(
    `INSERT INTO tenants (slug, name, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [cfg.slug, cfg.name]
  );

  // 2. Brand config
  await query(
    `INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET brand_voice = EXCLUDED.brand_voice,
           persona     = EXCLUDED.persona,
           audience    = EXCLUDED.audience`,
    [tenant.id, cfg.brandVoice, cfg.persona, cfg.audience]
  );

  // 3. Knowledge base -> embeddings (checksum-idempotent)
  const { sourceId } = await addContentSource({ embed: llm.embed }, {
    tenantId: tenant.id, kind: "api", ref: "seed-demo",
  });
  const { documentId, chunkCount } = await ingestText({ embed: llm.embed }, {
    tenantId: tenant.id, sourceId, title: `${cfg.name} — core facts`, text: cfg.knowledge.trim(),
  });

  // 4. Real marketing goal -> pending draft
  const result = await dispatch({ llm, getConfig: getTenantConfig }, {
    tenantId: tenant.id,
    topic: cfg.topic,
    channel: cfg.channel,
  });
  const [draft] = await query<{ id: number; agent: string; channel: string; status: string; content: string }>(
    `SELECT id, agent, channel, status, content FROM drafts WHERE id = $1`,
    [result.draftId]
  );

  return {
    tenantId: tenant.id,
    tenantSlug: cfg.slug,
    documentId,
    chunkCount,
    runId: result.runId,
    agent: result.agent,
    routeReason: result.routeReason,
    draft,
  };
}
