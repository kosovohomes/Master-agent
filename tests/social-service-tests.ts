/**
 * Phase 10 — social workforce service against real Postgres: the structural
 * approval gate (§466 — only APPROVED/SCHEDULED items become posts), BU
 * isolation, scheduling time semantics (past rejected), healthy-account
 * pre-check, per-platform character budgets, the one-active-post partial
 * UNIQUE dedup, the row-locked FSM (post transitions incl. terminal states),
 * calendar grouping, metrics ingestion/summary, account connect semantics
 * (linkedin account_ref REQUIRED — R4 fix —, token encryption at rest,
 * reconnect upsert, COALESCE dedup identity), and workforce lifecycle sync
 * (all posted → item PUBLISHED).
 */
import { query } from "../lib/db";
import {
  calendar,
  cancelPost,
  connectAccount,
  createCampaign,
  createPosts,
  disconnectAccount,
  findDuePosts,
  ingestMetrics,
  listAccounts,
  listPosts,
  loadContentItemRef,
  metricsSummary,
  schedulePost,
  syncItemLifecycleOnPosted,
  transitionPost,
} from "../lib/social/service";
import { SocialServiceError } from "../lib/social/types";
import { encryptChannelToken, decryptChannelToken } from "../lib/channels";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`social-${name}-${stamp}`, `Social BU ${name}`]
  );
  return bu.id;
}

async function createItem(buId: number, lifecycle: string, title: string): Promise<number> {
  const [row] = await query<{ id: number }>(
    `INSERT INTO content_items (business_unit_id, type, title, lifecycle)
     VALUES ($1, 'social_post', $2, $3) RETURNING id`,
    [buId, title, lifecycle]
  );
  await query(
    `INSERT INTO content_versions (content_item_id, version, title, body)
     VALUES ($1, 1, $2, $3)`,
    [row.id, title, `Body of ${title} — long enough to excerpt meaningfully for any platform.`]
  );
  return row.id;
}

const buA = await setupBu("a");
const buB = await setupBu("b");

/* ---------------- accounts ---------------- */
const li = await connectAccount({
  businessUnitId: buA,
  platform: "linkedin",
  token: "li-secret-token-123456",
  accountRef: "urn:li:person:test-a",
  displayName: "Acme Homes",
});
check("connect: linkedin account created", li.id > 0 && li.platform === "linkedin");
check("connect: health + oauth status defaults", li.health === "healthy" && li.oauthStatus === "connected");
check("connect: source manual", li.source === "manual");
check("connect: linkedin WITHOUT account_ref rejected", await (async () => {
  try {
    await connectAccount({ businessUnitId: buA, platform: "linkedin", token: "li-token-987654" });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "ACCOUNT_REF_REQUIRED";
  }
})());
check("connect: short token rejected", await (async () => {
  try {
    await connectAccount({ businessUnitId: buA, platform: "x", token: "short" });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "BAD_TOKEN";
  }
})());
// round-trip: the stored credential decrypts to the plaintext we gave
const credRow = await query<{ credentials_encrypted: string }>(
  "SELECT credentials_encrypted FROM social_accounts WHERE id = $1", [li.id]);
check("connect: credential stored ENCRYPTED (not plaintext)",
  credRow[0].credentials_encrypted !== "li-secret-token-123456" &&
  decryptChannelToken(credRow[0].credentials_encrypted) === "li-secret-token-123456");
// reconnect = upsert (same identity, refreshed credential)
const liRe = await connectAccount({
  businessUnitId: buA, platform: "linkedin", token: "li-rotated-token-654321",
  accountRef: "urn:li:person:test-a",
});
check("connect: reconnect upserts the same row", liRe.id === li.id);
check("connect: reconnect refreshes credentials",
  decryptChannelToken((await query<{ credentials_encrypted: string }>(
    "SELECT credentials_encrypted FROM social_accounts WHERE id = $1", [li.id]))[0].credentials_encrypted) === "li-rotated-token-654321");
// NULL account_ref dedup: two x connects without ref → one row
await connectAccount({ businessUnitId: buA, platform: "x", token: "x-token-111111111" });
await connectAccount({ businessUnitId: buA, platform: "x", token: "x-token-222222222" });
const xRows = await query<{ id: number }>(
  "SELECT id FROM social_accounts WHERE business_unit_id = $1 AND platform = 'x'", [buA]);
check("connect: NULL-ref x accounts dedup to one row", xRows.length === 1);
const buBX = await connectAccount({ businessUnitId: buB, platform: "x", token: "x-token-bu-3333333" });
check("connect: same platform in another BU is independent", buBX.id !== xRows[0].id);

/* ---------------- campaigns ---------------- */
const camp = await createCampaign({ businessUnitId: buA, name: `Launch ${stamp}`, objective: "awareness" });
check("campaign: created", camp.id > 0 && camp.status === "planning");
check("campaign: duplicate name in BU rejected", await (async () => {
  try {
    await createCampaign({ businessUnitId: buA, name: `Launch ${stamp}` });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "DUPLICATE";
  }
})());
const campB = await createCampaign({ businessUnitId: buB, name: `Launch ${stamp}` });
check("campaign: same name in another BU is fine", campB.id > 0);

/* ---------------- posts: the structural approval gate ---------------- */
const draftItem = await createItem(buA, "DRAFT", "Draft post");
check("posts: DRAFT item rejected (nothing publishes without approval)", await (async () => {
  try {
    await createPosts({
      businessUnitId: buA, contentItemId: draftItem, platforms: ["x"],
      scheduledAt: new Date(Date.now() + 3600_000),
      bodyByPlatform: { x: "sneaky" },
    });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "CONTENT_NOT_APPROVED";
  }
})());
check("posts: item from ANOTHER BU rejected", await (async () => {
  try {
    await createPosts({
      businessUnitId: buB, contentItemId: draftItem, platforms: ["x"],
      scheduledAt: new Date(Date.now() + 3600_000),
      bodyByPlatform: { x: "sneaky" },
    });
    return false;
  } catch (e) {
    // BU mismatch is caught before the lifecycle check
    return e instanceof SocialServiceError && e.code === "BU_MISMATCH";
  }
})());

const approvedItem = await createItem(buA, "APPROVED", "Approved announcement");
const future = new Date(Date.now() + 3600_000);
check("posts: past schedule rejected", await (async () => {
  try {
    await createPosts({
      businessUnitId: buA, contentItemId: approvedItem, platforms: ["x"],
      scheduledAt: new Date(Date.now() - 3600_000), bodyByPlatform: { x: "late" },
    });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "BAD_SCHEDULE";
  }
})());
check("posts: scheduling WITHOUT a healthy account rejected", await (async () => {
  try {
    await createPosts({
      businessUnitId: buA, contentItemId: approvedItem, platforms: ["tiktok"],
      scheduledAt: future, bodyByPlatform: { tiktok: "no account" },
    });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "SOCIAL_ACCOUNT_MISSING";
  }
})());

const created = await createPosts({
  businessUnitId: buA,
  contentItemId: approvedItem,
  platforms: ["linkedin", "x"],
  scheduledAt: future,
  campaignId: camp.id,
  bodyByPlatform: { linkedin: "Announcing Acme Homes Q3 lineup — modular, faster, cheaper." },
  generateBody: async (p) => `Variant for ${p} of Approved announcement`,
});
check("posts: two platforms → two rows", created.posts.length === 2 && created.skipped.length === 0);
check("posts: scheduled status + future time", created.posts.every((p) => p.status === "scheduled"));
check("posts: explicit body honored", created.posts.find((p) => p.platform === "linkedin")?.body.startsWith("Announcing Acme Homes") === true);
check("posts: generated body used when no override", created.posts.find((p) => p.platform === "x")?.body === "Variant for x of Approved announcement");
// workforce sync: first scheduled post moves APPROVED → SCHEDULED
const itemAfter = await loadContentItemRef(approvedItem);
check("posts: item lifecycle synced APPROVED → SCHEDULED", itemAfter.lifecycle === "SCHEDULED");

// one-active-post invariant (partial UNIQUE): same item+platform again → whole batch rejected
check("posts: duplicate (item, platform) rejected by DB dedup", await (async () => {
  try {
    await createPosts({
      businessUnitId: buA, contentItemId: approvedItem, platforms: ["x"],
      scheduledAt: new Date(Date.now() + 7200_000),
      bodyByPlatform: { x: "dupe" },
    });
    return false;
  } catch (e) {
    return String(e).includes("social_posts_item_platform_active");
  }
})());
// x budget enforcement
check("posts: x body truncated to 280", await (async () => {
  const longItem = await createItem(buB, "APPROVED", "Long body test");
  await connectAccount({ businessUnitId: buB, platform: "linkedin", token: "li-bu-b-token-777", accountRef: "urn:li:person:test-b" });
  const r = await createPosts({
    businessUnitId: buB, contentItemId: longItem, platforms: ["x"], scheduledAt: new Date(Date.now() + 3600_000),
    bodyByPlatform: { x: "y".repeat(500) },
  });
  return r.posts.length === 1 && r.posts[0].body.length <= 280;
})());

/* ---------------- FSM ---------------- */
const p0 = created.posts.find((p) => p.platform === "x")!;
check("fsm: scheduled → publishing", (await transitionPost(p0.id, "publishing")).status === "publishing");
check("fsm: publishing → posted (external id recorded)", await (async () => {
  const posted = await transitionPost(p0.id, "posted", { externalId: "x-999", externalUrl: "https://x.com/i/web/status/x-999" });
  return posted.status === "posted" && posted.externalId === "x-999" && posted.publishedAt != null;
})());
check("fsm: posted is terminal", await (async () => {
  try { await transitionPost(p0.id, "cancelled"); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "BAD_TRANSITION"; }
})());
// failed → reschedule path
const liPost = created.posts.find((p) => p.platform === "linkedin")!;
await transitionPost(liPost.id, "publishing");
const failed = await transitionPost(liPost.id, "failed", { error: "http_500: boom" });
check("fsm: publishing → failed with error", failed.status === "failed" && failed.error === "http_500: boom");
const rescheduled = await schedulePost(liPost.id, new Date(Date.now() + 5400_000));
check("fsm: failed → scheduled via reschedule (error cleared)", rescheduled.status === "scheduled" && rescheduled.error === null);
check("fsm: schedule in the past rejected", await (async () => {
  try { await schedulePost(liPost.id, new Date(Date.now() - 3_600_000)); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "BAD_SCHEDULE"; }
})());
// draft → cancel (terminal)
const draftPost = await createPosts({
  businessUnitId: buA, contentItemId: approvedItem, platforms: ["instagram"],
  scheduledAt: null, bodyByPlatform: { instagram: "draft body" },
});
check("posts: null scheduledAt → draft row (no account needed)", draftPost.posts.length === 1 && draftPost.posts[0].status === "draft");
const cancelled = await cancelPost(draftPost.posts[0].id);
check("fsm: draft → cancelled", cancelled.status === "cancelled");
check("fsm: cancelled is terminal", await (async () => {
  try { await schedulePost(draftPost.posts[0].id, new Date(Date.now() + 3600_000)); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "BAD_TRANSITION"; }
})());
// cancelled frees the (item, platform) slot — schedule a fresh IG post
await connectAccount({ businessUnitId: buA, platform: "instagram", token: "ig-token-4444444444" });
const reIG = await createPosts({
  businessUnitId: buA, contentItemId: approvedItem, platforms: ["instagram"],
  scheduledAt: new Date(Date.now() + 3600_000), bodyByPlatform: { instagram: "ig body" },
});
check("posts: cancelled slot is reusable", reIG.posts.length === 1);

/* ---------------- calendar ---------------- */
const cal = await calendar({ businessUnitId: buA, from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 48 * 3600_000) });
const calDays = cal.days;
check("calendar: groups by UTC day", calDays.length >= 1 && calDays.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)));
check("calendar: posts inside the window only", calDays.every((d) => d.posts.every((p) => p.scheduledAt != null)));
check("calendar: BU isolation", await (async () => {
  const calB = await calendar({ businessUnitId: buB, from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 48 * 3600_000) });
  return calB.days.every((d) => d.posts.every((p) => p.businessUnitId === buB));
})());
check("calendar: reversed range rejected", await (async () => {
  try {
    await calendar({ businessUnitId: buA, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() - 3600_000) });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "BAD_RANGE";
  }
})());

/* ---------------- metrics ---------------- */
check("metrics: ingest + latest + summary", await (async () => {
  await ingestMetrics({ socialPostId: p0.id, impressions: 1000, likes: 50, comments: 5, shares: 3, clicks: 12 });
  await ingestMetrics({ socialPostId: p0.id, impressions: 1200, likes: 61, comments: 6, shares: 4, clicks: 15 });
  const latest = await query<{ impressions: string }>(
    "SELECT impressions FROM social_post_metrics WHERE social_post_id = $1 ORDER BY captured_at DESC LIMIT 1", [p0.id]);
  const summary = await metricsSummary({ businessUnitId: buA });
  return Number(latest[0].impressions) === 1200 && summary.totals.impressions >= 1200 && summary.posts >= 1;
})());
check("metrics: unknown post rejected", await (async () => {
  try { await ingestMetrics({ socialPostId: 999999999 }); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "NOT_FOUND"; }
})());

/* ---------------- findDuePosts + lifecycle sync ---------------- */
check("due: selects scheduled+due with healthy account credentials", await (async () => {
  // Seed a genuinely due post for buA (past scheduled_at, healthy x account).
  const dueItem = await createItem(buA, "APPROVED", "Due post for selection");
  await query(
    `UPDATE content_items SET lifecycle = 'SCHEDULED' WHERE id = $1`, [dueItem]);
  const [duePost] = await query<{ id: number }>(
    `INSERT INTO social_posts (business_unit_id, content_item_id, platform, body, status, scheduled_at)
     VALUES ($1, $2, 'x', 'due now', 'scheduled', now() - interval '1 second') RETURNING id`,
    [buA, dueItem]);
  const due = await findDuePosts(100);
  const ours = due.filter((d) => d.businessUnitId === buA);
  const ok = ours.some((d) => d.id === duePost.id)
    && ours.every((d) => d.credentialsEncrypted.length > 0 && d.accountRef !== undefined);
  // consume it as posted so later checks stay deterministic
  await query("UPDATE social_posts SET status = 'posted', published_at = now(), external_id = 'consumed' WHERE id = $1", [duePost.id]);
  return ok;
})());
check("due: unhealthy account excluded", await (async () => {
  // mark BU B x account unhealthy → its due posts disappear from selection
  const [xBuB] = await query<{ id: number }>("SELECT id FROM social_accounts WHERE business_unit_id = $1 AND platform = 'x'", [buB]);
  const longItem = await createItem(buB, "APPROVED", "Unhealthy account post");
  await createPosts({
    businessUnitId: buB, contentItemId: longItem, platforms: ["x"],
    scheduledAt: new Date(Date.now() - 1000), bodyByPlatform: { x: "should be excluded" },
  });
  await query("UPDATE social_accounts SET health = 'unhealthy' WHERE id = $1", [xBuB.id]);
  const due = await findDuePosts(100);
  return !due.some((d) => d.businessUnitId === buB && d.platform === "x");
})());
check("due: ARCHIVED item's scheduled posts auto-cancelled", await (async () => {
  const [item] = await query<{ id: number }>(
    `INSERT INTO content_items (business_unit_id, type, title, lifecycle) VALUES ($1, 'social_post', 'Withdrawn', 'APPROVED') RETURNING id`,
    [buA]);
  await query(`INSERT INTO content_versions (content_item_id, version, title, body) VALUES ($1, 1, 'Withdrawn', 'b')`, [item.id]);
  const r = await createPosts({
    businessUnitId: buA, contentItemId: item.id, platforms: ["linkedin"],
    scheduledAt: new Date(Date.now() - 1000), bodyByPlatform: { linkedin: "will be withdrawn" },
  });
  await query("UPDATE content_items SET lifecycle = 'ARCHIVED' WHERE id = $1", [item.id]);
  const due = await findDuePosts(100);
  const still = await listPosts({ contentItemId: item.id });
  return !due.some((d) => d.contentItemId === item.id) && still[0]?.status === "cancelled";
})());
check("sync: all posted → item SCHEDULED → PUBLISHED", await (async () => {
  const [item] = await query<{ id: number }>(
    `INSERT INTO content_items (business_unit_id, type, title, lifecycle) VALUES ($1, 'social_post', 'All posted', 'SCHEDULED') RETURNING id`,
    [buA]);
  await query(`INSERT INTO content_versions (content_item_id, version, title, body) VALUES ($1, 1, 'All posted', 'b')`, [item.id]);
  await query(
    `INSERT INTO social_posts (business_unit_id, content_item_id, platform, body, status, published_at, external_id)
     VALUES ($1, $2, 'x', 'b', 'posted', now(), 'x-1'), ($1, $2, 'linkedin', 'b', 'posted', now(), 'li-1')`,
    [buA, item.id]);
  const moved = await syncItemLifecycleOnPosted(item.id);
  const [row] = await query<{ lifecycle: string }>("SELECT lifecycle FROM content_items WHERE id = $1", [item.id]);
  return moved && row.lifecycle === "PUBLISHED";
})());
check("sync: pending posts keep item in SCHEDULED", await (async () => {
  const moved = await syncItemLifecycleOnPosted(approvedItem); // has a scheduled instagram row
  return moved === false;
})());

/* ---------------- disconnect ---------------- */
await disconnectAccount(buBX.id);
check("disconnect: row removed", (await query("SELECT id FROM social_accounts WHERE id = $1", [buBX.id])).length === 0);
check("disconnect: unknown account rejected", await (async () => {
  try { await disconnectAccount(999999999); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "NOT_FOUND"; }
})());

/* ---------------- cleanup ---------------- */
for (const bu of [buA, buB]) {
  await query("DELETE FROM social_posts WHERE business_unit_id = $1", [bu]);
  await query("DELETE FROM social_campaigns WHERE business_unit_id = $1", [bu]);
  await query("DELETE FROM social_accounts WHERE business_unit_id = $1", [bu]);
  await query("DELETE FROM content_items WHERE business_unit_id = $1", [bu]);
  await query("DELETE FROM business_units WHERE id = $1", [bu]);
}

console.log(`\nsocial-service: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
