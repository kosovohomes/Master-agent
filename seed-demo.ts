/**
 * AgentOS — end-to-end demo seeder
 * =================================
 * Drop this file into  scripts/seed-demo.ts  of your local checkout, then run:
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/seed-demo.ts
 *
 * What it does (safe to re-run — idempotent):
 *   1. Creates (or reuses) a tenant + its brand config
 *   2. Creates a content source and ingests knowledge text
 *      (OpenAI text-embedding-3-small -> pgvector chunks)
 *   3. Dispatches a real marketing goal through the orchestrator
 *      (real OpenAI copy -> a `pending` draft in the approval queue)
 *   4. Prints the generated draft + the exact next steps
 *
 * Requirements: .env.local with DATABASE_URL + OPENAI_API_KEY set,
 * and the schema already migrated (npm run migrate).
 */

import { query } from "../lib/db";
import { llm } from "../lib/llm";
import { addContentSource, ingestText } from "../lib/rag/ingest";
import { dispatch, getTenantConfig } from "../lib/agents/dispatch";

// ---------------------------------------------------------------------------
// Edit these to match the brand you want to demo with
// ---------------------------------------------------------------------------
const TENANT = {
  slug: process.env.DEMO_SLUG ?? "acme-homes",
  name: process.env.DEMO_NAME ?? "Acme Homes",
  brandVoice: "Warm, confident, plain-spoken. Short sentences. No hype words.",
  persona: "A trusted local home-builder who has delivered 500+ families their dream home.",
  audience: "First-time home buyers and young families in the Prishtina metro area.",
};

const KNOWLEDGE_TEXT = `
Acme Homes builds energy-efficient family homes in the Prishtina metro area.
Every home includes triple-glazed windows, a heat pump, and a 10-year structural
warranty. Our autumn collection starts at EUR 89,000 with move-in dates from
March 2027. We offer guided weekend viewings at our model village in Dragodan,
Saturdays and Sundays 10:00-16:00, no appointment needed. Buyers can reserve a
plot with a refundable EUR 500 deposit. We partner with three local banks to
offer mortgage pre-approval in under 48 hours. Our customer satisfaction score
for 2025 handovers was 4.8 out of 5 based on 214 reviews.
`;

const MARKETING_GOAL = {
  // NOTE: topic wording matters — the router is keyword-based.
  // Avoid "research", "outreach", "promote", "event" etc. unless you WANT a different agent.
  topic: "Announce our autumn collection of energy-efficient family homes starting at EUR 89,000",
  channel: "linkedin", // one of: linkedin | x | email (instagram/tiktok are draft-only in v1)
};

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n== AgentOS demo seeder ==\n`);

  // 1. Tenant (upsert by slug)
  const [tenant] = await query<{ id: number; name: string }>(
    `INSERT INTO tenants (slug, name, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name`,
    [TENANT.slug, TENANT.name]
  );
  console.log(`[1/4] tenant ready: id=${tenant.id} slug=${TENANT.slug}`);

  // 2. Brand config
  await query(
    `INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET brand_voice = EXCLUDED.brand_voice,
           persona     = EXCLUDED.persona,
           audience    = EXCLUDED.audience`,
    [tenant.id, TENANT.brandVoice, TENANT.persona, TENANT.audience]
  );
  console.log(`[2/4] brand config saved`);

  // 3. Knowledge base -> embeddings (checksum-idempotent)
  const { sourceId } = await addContentSource({ embed: llm.embed }, {
    tenantId: tenant.id, kind: "api", ref: "seed-demo",
  });
  const { documentId, chunkCount } = await ingestText({ embed: llm.embed }, {
    tenantId: tenant.id, sourceId, title: "Acme Homes — core facts", text: KNOWLEDGE_TEXT.trim(),
  });
  console.log(`[3/4] knowledge ingested: document=${documentId} chunks=${chunkCount}`);

  // 4. Run a real marketing goal -> pending draft
  const result = await dispatch({ llm, getConfig: getTenantConfig }, {
    tenantId: tenant.id,
    topic: MARKETING_GOAL.topic,
    channel: MARKETING_GOAL.channel,
  });
  const [draft] = await query<{ id: number; agent: string; channel: string; status: string; content: string }>(
    `SELECT id, agent, channel, status, content FROM drafts WHERE id = $1`,
    [result.draftId]
  );

  console.log(`[4/4] draft generated:
    runId:    ${result.runId}
    draftId:  ${draft.id}
    agent:    ${result.agent} (router said: "${result.routeReason}")
    channel:  ${draft.channel}
    status:   ${draft.status}

  ---------- generated draft ----------
  ${draft.content}
  --------------------------------------

  NEXT STEPS
  1. Open your deployed /admin, log in with ADMIN_PASSWORD, paste tenant id ${tenant.id} -> Load
  2. Approve draft ${draft.id}, then schedule it
  3. The cron sweep (every 15 min) publishes scheduled drafts to ${draft.channel}
     (or force it: GET /api/agents/sweep with header  x-cron-secret: <CRON_SECRET>)

  Your tenant id for /api/v1/widget/config and /api/v1/chat is: ${tenant.id}
`);
  process.exit(0);
}

main().catch((e) => {
  console.error("SEED FAILED:", e?.message ?? e);
  process.exit(1);
});
