/**
 * Phase 10 — social_sweep task handler against real task rows: flag gate
 * (fail-closed skip), the idempotency claim (§88 — a pre-claimed key means
 * the post stays scheduled and the sweep counts a prevented duplicate),
 * adapter success → posted + publication published + social.posted event,
 * adapter failure → failed + social.failed event, auth-shaped failures
 * poison the ACCOUNT (health=unhealthy) not the machinery, IG/TikTok
 * draft-only policy gate (skipped BEFORE the claim, post stays scheduled),
 * all-posted → content item SCHEDULED → PUBLISHED sync, and best-effort
 * provider metrics refresh (changed snapshot ingested, identical skipped).
 */
import { query } from "../lib/db";
import { spawnTask } from "../lib/tasks/queue";
import { makeSocialSweepHandler, socialPublicationKey } from "../lib/social/tasks";
import { connectAccount } from "../lib/social/service";
import type { SocialAdapter } from "../lib/social/adapters";
import type { TaskHandlerInput, TaskRow } from "../lib/tasks/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function flag(key: string, on: boolean): Promise<void> {
  await query(
    `INSERT INTO feature_flags (key, enabled, emergency, description) VALUES ($1, $2, FALSE, 'test')
     ON CONFLICT (key) DO UPDATE SET enabled = $2`,
    [key, on]
  );
}
const socialFlagBefore = (await query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key = 'social'"))[0]?.enabled ?? false;
const igFlagBefore = (await query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key = 'social_publish_ig_tiktok'"))[0]?.enabled ?? false;

const [bu] = await query<{ id: number }>(
  `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
  [`social-sweep-${stamp}`, `Social Sweep BU`]
);
const buId = bu.id;

const acc = await connectAccount({
  businessUnitId: buId, platform: "x", token: "sweep-x-token-000001", displayName: "Sweep X",
});
const accLi = await connectAccount({
  businessUnitId: buId, platform: "linkedin", token: "sweep-li-token-000002",
  accountRef: "urn:li:person:sweep", displayName: "Sweep LI",
});
const accIg = await connectAccount({
  businessUnitId: buId, platform: "instagram", token: "sweep-ig-token-000003", displayName: "Sweep IG",
});

async function seedItem(lifecycle: string, title: string): Promise<number> {
  const [item] = await query<{ id: number }>(
    `INSERT INTO content_items (business_unit_id, type, title, lifecycle) VALUES ($1, 'social_post', $2, $3) RETURNING id`,
    [buId, title, lifecycle]
  );
  await query(`INSERT INTO content_versions (content_item_id, version, title, body) VALUES ($1, 1, $2, 'body')`, [item.id, title]);
  return item.id;
}

async function seedPost(itemId: number, platform: string, body: string): Promise<number> {
  const [p] = await query<{ id: number }>(
    `INSERT INTO social_posts (business_unit_id, content_item_id, platform, body, status, scheduled_at)
     VALUES ($1, $2, $3, $4, 'scheduled', now() - interval '1 second') RETURNING id`,
    [buId, itemId, platform, body]
  );
  return p.id;
}

function makeStepRecorder(): Omit<TaskHandlerInput, "task"> {
  return {
    step: async (_name: string, fn: () => Promise<Record<string, unknown> | void>) => fn(),
    cancelled: async () => false,
  };
}
async function loadTask(id: number): Promise<TaskRow> {
  return (await query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]))[0];
}
async function runSweep(deps: { adapterFor?: (p: string) => Partial<SocialAdapter> } = {}): Promise<Record<string, unknown>> {
  await spawnTask({ kind: "social_sweep", payload: {}, createdBy: "test", idempotencyKey: `social_sweep:test:${stamp}:${Math.random()}` });
  const task = (await query<TaskRow>("SELECT * FROM tasks WHERE kind = 'social_sweep' ORDER BY id DESC LIMIT 1"))[0];
  const handler = makeSocialSweepHandler({
    adapterFor: (platform) => (deps.adapterFor?.(platform) ?? {}) as never,
  });
  return (await handler({ task, ...makeStepRecorder() })) as Record<string, unknown>;
}

/* ---------------- flag gate ---------------- */
await flag("social", false);
const offResult = await runSweep();
check("flag OFF: handler skips fail-closed", offResult.skipped === true && offResult.reason === "social_flag_off");

await flag("social", true);
await flag("social_publish_ig_tiktok", false);

/* ---------------- happy path: x posted, item sync ---------------- */
const item1 = await seedItem("SCHEDULED", "Sweep happy path");
const post1 = await seedPost(item1, "x", "Hello from the sweep");
const calls: string[] = [];
const result1 = await runSweep({
  adapterFor: (p) => ({
    publish: async (_ctx, input) => {
      calls.push(`${p}:${input.body}`);
      return { externalId: `ext-${p}-${post1}`, externalUrl: `https://x.com/i/web/status/ext-${post1}` };
    },
  }),
});
check("sweep: due post published", result1.posted === 1 && result1.failed === 0,
  `posted=${result1.posted} failed=${result1.failed} due=${result1.due} calls=${calls.length}`);
check("sweep: adapter received decrypted body", calls.some((c) => c === `x:Hello from the sweep`));
const post1Row = (await query<{ status: string; external_id: string; published_at: string | null }>(
  "SELECT status, external_id, published_at FROM social_posts WHERE id = $1", [post1]))[0];
check("sweep: post FSM → posted with external id", post1Row.status === "posted" && post1Row.external_id === `ext-x-${post1}` && post1Row.published_at != null);
const pub1 = (await query<{ status: string; idempotency_key: string; social_post_id: number }>(
  "SELECT status, idempotency_key, social_post_id FROM content_publications WHERE social_post_id = $1", [post1]))[0];
check("sweep: publication row published via social claim key",
  pub1?.status === "published" && pub1.idempotency_key.startsWith(`social:${post1}:`));
check("sweep: social.posted event emitted", ((await query<{ id: number }>(
  "SELECT id FROM events WHERE name = 'social.posted' AND payload->>'postId' = $1", [String(post1)])).length) === 1);
const item1Lifecycle = (await query<{ lifecycle: string }>("SELECT lifecycle FROM content_items WHERE id = $1", [item1]))[0].lifecycle;
check("sweep: all posted → item SCHEDULED → PUBLISHED", item1Lifecycle === "PUBLISHED");

/* ---------------- idempotency claim ---------------- */
const item2 = await seedItem("SCHEDULED", "Sweep idempotency");
const post2 = await seedPost(item2, "x", "Claimed already");
// Pre-claim the publication row with the EXACT key the sweep will compute.
const dueRow = (await query<{ scheduled_at: string }>("SELECT scheduled_at FROM social_posts WHERE id = $1", [post2]))[0];
await query(
  `INSERT INTO content_publications (social_post_id, business_unit_id, channel, idempotency_key, status, attempted_at)
   VALUES ($1, $2, 'x', $3, 'pending', now())`,
  [post2, buId, socialPublicationKey(post2, dueRow.scheduled_at)]
);
const result2 = await runSweep({
  adapterFor: () => ({ publish: async () => ({ externalId: "should-not-happen", externalUrl: null }) }),
});
check("claim: pre-claimed key → duplicate prevented, adapter NOT called",
  (result2.duplicates_prevented as number) >= 1 &&
  !(result2.publications as Array<{ postId: number }>).some((p) => p.postId === post2));
check("claim: post stays scheduled (owner of the claim publishes later)",
  (await query<{ status: string }>("SELECT status FROM social_posts WHERE id = $1", [post2]))[0].status === "scheduled");

/* ---------------- adapter failure ---------------- */
const item3 = await seedItem("SCHEDULED", "Sweep failure");
const post3 = await seedPost(item3, "x", "Will fail");
const result3 = await runSweep({
  adapterFor: () => ({ publish: async () => { throw new Error("http_500: provider exploded"); } }),
});
check("sweep: adapter failure counted", result3.failed === 1);
const post3Row = (await query<{ status: string; error: string }>(
  "SELECT status, error FROM social_posts WHERE id = $1", [post3]))[0];
check("sweep: post → failed with error", post3Row.status === "failed" && post3Row.error.includes("http_500"));
check("sweep: publication row failed", (await query<{ status: string }>(
  "SELECT status FROM content_publications WHERE social_post_id = $1", [post3]))[0].status === "failed");
check("sweep: social.failed event emitted", ((await query<{ id: number }>(
  "SELECT id FROM events WHERE name = 'social.failed' AND payload->>'postId' = $1", [String(post3)])).length) === 1);
check("sweep: 5xx failure does NOT poison the account", (await query<{ health: string }>(
  "SELECT health FROM social_accounts WHERE id = $1", [acc.id]))[0].health === "healthy");

/* ---------------- auth-shaped failure poisons the account ---------------- */
const item4 = await seedItem("SCHEDULED", "Sweep auth failure");
const post4 = await seedPost(item4, "x", "Bad credentials");
await runSweep({
  adapterFor: () => ({ publish: async () => { throw new Error("http_401: invalid token"); } }),
});
const accAfter = (await query<{ health: string; oauth_status: string }>(
  "SELECT health, oauth_status FROM social_accounts WHERE id = $1", [acc.id]))[0];
check("sweep: 401 marks the account unhealthy + oauth error", accAfter.health === "unhealthy" && accAfter.oauth_status === "error",
  JSON.stringify(accAfter));
// restore for later checks
await query("UPDATE social_accounts SET health = 'healthy', oauth_status = 'connected' WHERE id = $1", [acc.id]);

/* ---------------- IG/TikTok draft-only gate ---------------- */
const item5 = await seedItem("SCHEDULED", "Sweep draft-only");
const post5 = await seedPost(item5, "instagram", "IG stays draft");
let igCalled = false;
const result5 = await runSweep({
  adapterFor: (p) => p === "instagram"
    ? { publish: async () => { igCalled = true; return { externalId: "nope", externalUrl: null }; } }
    : { publish: async () => ({ externalId: "other", externalUrl: null }) },
});
check("draft-only: instagram skipped BEFORE the claim", (result5.skipped_draft_only as number) >= 1 && !igCalled);
check("draft-only: post stays scheduled (not failed)", (await query<{ status: string }>(
  "SELECT status FROM social_posts WHERE id = $1", [post5]))[0].status === "scheduled");
check("draft-only: no publication claim consumed", (await query<{ id: number }>(
  "SELECT id FROM content_publications WHERE social_post_id = $1", [post5])).length === 0);

/* ---------------- metrics refresh ---------------- */
const post1Metrics = await query<{ external_id: string }>("SELECT external_id FROM social_posts WHERE id = $1", [post1]);
let metricsCalls = 0;
await query("UPDATE social_posts SET status = 'posted', published_at = now(), external_id = $2 WHERE id = $1", [post2, `ext-x-${post2}`]);
const result6 = await runSweep({
  adapterFor: () => ({
    publish: async () => ({ externalId: "unused", externalUrl: null }),
    fetchMetrics: async () => {
      metricsCalls++;
      return { impressions: 500 + metricsCalls, likes: 10, comments: 1, shares: 0, clicks: 3 };
    },
  }),
});
check("metrics: provider snapshot ingested for recent posted post", (result6.metrics_refreshed as number) >= 1);
const snapCount1 = (await query<{ c: string }>(
  "SELECT COUNT(*)::text AS c FROM social_post_metrics WHERE social_post_id = $1", [post2]))[0].c;
// identical snapshot → not re-ingested
await runSweep({
  adapterFor: () => ({
    publish: async () => ({ externalId: "unused", externalUrl: null }),
    fetchMetrics: async () => ({ impressions: 502, likes: 10, comments: 1, shares: 0, clicks: 3 }),
  }),
});
const snapCount2 = (await query<{ c: string }>(
  "SELECT COUNT(*)::text AS c FROM social_post_metrics WHERE social_post_id = $1", [post2]))[0].c;
check("metrics: identical snapshot skipped (no duplicate rows)", snapCount2 === snapCount1, `c1=${snapCount1} c2=${snapCount2}`);

/* ---------------- linkedin account_ref reaches the adapter ---------------- */
const item6 = await seedItem("SCHEDULED", "Sweep linkedin ref");
const post6 = await seedPost(item6, "linkedin", "LI with ref");
let seenRef: string | null = null;
await runSweep({
  adapterFor: () => ({
    publish: async (_ctx, input) => { seenRef = input.accountRef; return { externalId: "li-1", externalUrl: null }; },
  }),
});
check("sweep: linkedin account_ref (R4 fix) passed to the adapter", seenRef === "urn:li:person:sweep");
void accLi; void post6; void post1Metrics;

/* ---------------- restore flags + cleanup ---------------- */
await flag("social", socialFlagBefore);
await flag("social_publish_ig_tiktok", igFlagBefore);
await query("DELETE FROM content_publications WHERE social_post_id IN (SELECT id FROM social_posts WHERE business_unit_id = $1)", [buId]);
await query("DELETE FROM social_post_metrics WHERE social_post_id IN (SELECT id FROM social_posts WHERE business_unit_id = $1)", [buId]);
await query("DELETE FROM social_posts WHERE business_unit_id = $1", [buId]);
await query("DELETE FROM social_accounts WHERE business_unit_id = $1", [buId]);
await query("DELETE FROM content_items WHERE business_unit_id = $1", [buId]);
await query("DELETE FROM business_units WHERE id = $1", [buId]);

console.log(`\nsocial-sweep: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
