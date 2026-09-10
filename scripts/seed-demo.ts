/**
 * AgentOS — end-to-end demo seeder (CLI wrapper)
 * ==============================================
 * Run from your local checkout:
 *
 *   npm run seed
 *
 * The logic lives in lib/demo-seed.ts and is shared with the deployed
 * ops endpoint POST /api/admin/seed. Safe to re-run — idempotent.
 *
 * Requirements: .env.local with DATABASE_URL + OPENAI_API_KEY set,
 * and the schema already migrated (npm run migrate).
 */

import { runDemoSeed } from "../lib/demo-seed";

async function main() {
  console.log(`\n== AgentOS demo seeder ==\n`);
  const r = await runDemoSeed();
  console.log(`tenant:   id=${r.tenantId} slug=${r.tenantSlug}
ingested: document=${r.documentId} chunks=${r.chunkCount}
run:      id=${r.runId} agent=${r.agent} ("${r.routeReason}")
draft:    id=${r.draft.id} status=${r.draft.status} channel=${r.draft.channel}

---------- generated draft ----------
${r.draft.content}
--------------------------------------

NEXT STEPS
1. Open /admin, log in with ADMIN_PASSWORD, paste tenant id ${r.tenantId} -> Load
2. Approve draft ${r.draft.id}, then schedule it
3. The cron sweep publishes scheduled drafts (or force it:
   GET /api/agents/sweep with header x-cron-secret: <CRON_SECRET>)

Your tenant id for /api/v1/widget/config and /api/v1/chat is: ${r.tenantId}
`);
  process.exit(0);
}

main().catch((e) => {
  console.error("SEED FAILED:", e?.message ?? e);
  process.exit(1);
});
