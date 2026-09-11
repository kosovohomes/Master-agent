import assert from "node:assert";
import { resetRateLimits } from "../lib/security/ratelimit";
import { getPublisher, sweepDue } from "../lib/agents/publishers/index";
import {
  createDraft, approveDraft, scheduleDraft, listDraftsByTenant,
} from "../lib/agents/approval";
import { query } from "../lib/db";
import { encryptChannelToken, decryptChannelToken } from "../lib/channels";
import { POST as sweepPOST } from "../app/api/agents/sweep/route";
import { POST as channelPOST } from "../app/api/v1/channels/route";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const mkTenant = async (slug: string, name: string): Promise<number> => {
  const [row] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [`${slug}-${stamp}`, name]
  );
  return row.id;
};
const createdTenantIds: number[] = [];
const addChannelsRow = async (tenantId: number, kind: string, plainToken: string) => {
  const enc = encryptChannelToken(plainToken);
  await query(
    "INSERT INTO channels (tenant_id, kind, token_encrypted, status) VALUES ($1, $2, $3, 'healthy')",
    [tenantId, kind, enc]
  );
  return enc;
};

try {
  await resetRateLimits(); // DB-backed buckets persist across suite processes
  // ==================================================================
  // 1. Email publisher posts to Resend-style API with injected fetch (brief verbatim)
  // ==================================================================
  let sent: any = null;
  const fakeFetch: typeof fetch = async (_url: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "email_out_id" }), { status: 200 });
  };
  const emailPub = getPublisher("email");
  const published = await emailPub.publish(
    { fetchImpl: fakeFetch, env: { EMAIL_TARGET: "ceo@acme.com", RESEND_API_KEY: "re_test" } as unknown as NodeJS.ProcessEnv },
    { channel: "email", content: "Subject: hello\n\nBody here", token: "", target: "ceo@acme.com" }
  );
  check("email publisher call recorded", sent?.to === "ceo@acme.com" && String(sent.text).includes("Body here"), JSON.stringify(sent));
  check("email publish returns external id", published.externalId === "email_out_id");

  // ==================================================================
  // 2. getPublisher returns the right publisher per kind
  // ==================================================================
  check("getPublisher linkedin kind", getPublisher("linkedin").kind === "linkedin");
  check("getPublisher x kind", getPublisher("x").kind === "x");
  check("getPublisher email kind", getPublisher("email").kind === "email");
  check("getPublisher instagram kind", getPublisher("instagram").kind === "instagram");
  check("getPublisher tiktok kind", getPublisher("tiktok").kind === "tiktok");
  let unknownErr = "";
  try { getPublisher("slack" as any); } catch (e) { unknownErr = (e as Error).message; }
  check("unknown kind throws", unknownErr.includes("no publisher"), unknownErr);

  // IG/TikTok publish rejects — draft-only in v1, never auto-posted
  for (const kind of ["instagram", "tiktok"] as const) {
    let igErr = "";
    try { await getPublisher(kind).publish({ env: {} as NodeJS.ProcessEnv }, { channel: kind, content: "x", token: "t" }); }
    catch (e) { igErr = (e as Error).message; }
    check(`${kind} publish rejected (draft-only)`, igErr.includes("draft-only"), igErr);
  }

  // ==================================================================
  // 3. Live HTTP publishers hit the right endpoint with the DECRYPTED token + payload
  // ==================================================================
  const calls: { url: string; method: string; auth: string; body: any }[] = [];
  const recFetch: typeof fetch = async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: (init?.headers as any)?.Authorization ?? "",
      body: JSON.parse(init?.body ?? "{}"),
    });
    return new Response(JSON.stringify({ id: `ext_${calls.length}` }), { status: 200 });
  };

  const plainTok = "plain-x-token-042";
  const xPub = getPublisher("x");
  const xRes = await xPub.publish(
    { fetchImpl: recFetch, env: {} as NodeJS.ProcessEnv },
    { channel: "x", content: "tweet text here", token: plainTok }
  );
  check("x publisher hits api.x.com/2/tweets", calls[0]?.url === "https://api.x.com/2/tweets", calls[0]?.url);
  check("x publisher sends POST", calls[0]?.method === "POST");
  check("x publisher sends DECRYPTED token as Bearer", calls[0]?.auth === `Bearer ${plainTok}`, calls[0]?.auth);
  check("x publisher sends raw content in body", calls[0]?.body?.text === "tweet text here");
  check("x publisher returns external id from response", xRes.externalId === "ext_1");

  const liTok = "li-decrypted-111";
  const liPub = getPublisher("linkedin");
  const liRes = await liPub.publish(
    { fetchImpl: recFetch, env: {} as NodeJS.ProcessEnv },
    { channel: "linkedin", content: "linkedin post body", token: liTok, target: "urn:li:person:abc123" }
  );
  check("linkedin publisher hits api.linkedin.com/v2/shares", calls[1]?.url === "https://api.linkedin.com/v2/shares", calls[1]?.url);
  check("linkedin publisher sends DECRYPTED token", calls[1]?.auth === `Bearer ${liTok}`, calls[1]?.auth);
  check("linkedin payload is PUBLIC published UGC share",
    calls[1]?.body?.lifecycleState === "PUBLISHED" &&
    calls[1]?.body?.visibility?.["com.linkedin.ugc.MemberNetworkVisibility"] === "PUBLIC" &&
    calls[1]?.body?.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary?.text === "linkedin post body");
  check("linkedin payload carries author target", calls[1]?.body?.author === "urn:li:person:abc123");
  check("linkedin publisher returns external id", liRes.externalId === "ext_2");

  let httpErr = "";
  const errFetch: typeof fetch = async () => new Response("rate limited", { status: 429 });
  try {
    await xPub.publish({ fetchImpl: errFetch, env: {} as NodeJS.ProcessEnv }, { channel: "x", content: "boom", token: "t" });
  } catch (e) { httpErr = (e as Error).message; }
  check("non-ok publisher response surfaces status error", httpErr.includes("x publish 429"), httpErr);

  // ==================================================================
  // 4. sweep posts only approved+scheduled drafts (brief) — channel must exist
  // ==================================================================
  const tA = await mkTenant("t11-a", "Pub Tenant A");
  createdTenantIds.push(tA);
  await addChannelsRow(tA, "email", "email-a-token");
  const { draftId } = await createDraft({ tenantId: tA, agent: "sales", channel: "email", content: "Subject: pitch\n\nBody" });
  await approveDraft(draftId);
  await scheduleDraft(draftId);

  const seen: string[] = [];
  const sweepRes = await sweepDue({
    publish(p) { seen.push(p.content); return Promise.resolve({ externalId: "x" }); },
  });
  check("sweep posts scheduled draft", sweepRes.posted === 1 && seen.length === 1, JSON.stringify(sweepRes));
  const rows = await listDraftsByTenant(tA);
  check("draft marked posted", rows[0].status === "posted", rows[0].status);
  const outOk = await query<{ status: string }>("SELECT status FROM content_publications WHERE draft_id = $1", [draftId]);
  check("publication row ok on success (content_publications)", outOk.length === 1 && outOk[0].status === "published", JSON.stringify(outOk));

  const pendingOnly = await listDraftsByTenant(tA, "pending");
  check("no pending drafts left", pendingOnly.length === 0);

  // ==================================================================
  // 5. self-review fix: sweep covers UNPUBLISHED scheduled drafts; pending drafts are never swept
  // ==================================================================
  const tB = await mkTenant("t11-b", "Pub Tenant B");
  createdTenantIds.push(tB);
  await addChannelsRow(tB, "x", "x-sched-tok");
  // one scheduled (approved) draft — still unpublished (no publication yet)
  const { draftId: schedId } = await createDraft({ tenantId: tB, agent: "marketing", channel: "x", content: "scheduled post" });
  await approveDraft(schedId);
  await scheduleDraft(schedId);
  // one pending draft that must survive the sweep untouched
  const { draftId: pendId } = await createDraft({ tenantId: tB, agent: "marketing", channel: "x", content: "still pending" });

  check("fix: scheduled draft is unpublished before sweep",
    (await listDraftsByTenant(tB, "scheduled")).find((r) => r.id === schedId) !== undefined &&
    (await query<{ n: string }>("SELECT count(*)::text AS n FROM content_publications WHERE draft_id = $1", [schedId]))[0].n === "0");

  const seenB: string[] = [];
  const sweepB = await sweepDue({ publish(p) { seenB.push(p.content); return Promise.resolve({ externalId: "b1" }); } });
  check("fix: unpublished scheduled draft IS swept", sweepB.posted === 1 && seenB.includes("scheduled post"), JSON.stringify(sweepB));
  check("fix: scheduled draft now posted",
    (await listDraftsByTenant(tB, "posted")).find((r) => r.id === schedId) !== undefined);
  check("pending draft is not swept — still pending, no publication",
    (await listDraftsByTenant(tB, "pending")).find((r) => r.id === pendId) !== undefined &&
    (await query<{ n: string }>("SELECT count(*)::text AS n FROM content_publications WHERE draft_id = $1", [pendId]))[0].n === "0");

  // ==================================================================
  // 6. publish failure -> draft failed, publication failed, channel marked unhealthy
  // ==================================================================
  const tC = await mkTenant("t11-c", "Pub Tenant C");
  createdTenantIds.push(tC);
  await addChannelsRow(tC, "x", "x-fail-tok");
  const { draftId: failId } = await createDraft({ tenantId: tC, agent: "marketing", channel: "x", content: "will fail" });
  await approveDraft(failId);
  await scheduleDraft(failId);
  const sweepC = await sweepDue({
    publish() { return Promise.reject(new Error("channel auth expired")); },
  });
  check("failed publish bumped failed count", sweepC.failed === 1 && sweepC.posted === 0, JSON.stringify(sweepC));
  check("failed draft marked failed", (await listDraftsByTenant(tC, "failed")).find((r) => r.id === failId) !== undefined);
  const outFail = await query<{ status: string; error: string }>("SELECT status, error FROM content_publications WHERE draft_id = $1", [failId]);
  check("failed publication row on error", outFail.length === 1 && outFail[0].status === "failed" && outFail[0].error.includes("auth expired"), JSON.stringify(outFail));
  const chState = await query<{ status: string }>("SELECT status FROM channels WHERE tenant_id = $1 AND kind = 'x'", [tC]);
  check("channel marked unhealthy after publish failure", chState[0]?.status === "unhealthy", JSON.stringify(chState));

  // ==================================================================
  // 6b. email with BLANK key -> clear failure on publication, no crash
  // ==================================================================
  const tD = await mkTenant("t11-d", "Pub Tenant D");
  createdTenantIds.push(tD);
  await addChannelsRow(tD, "email", "whatever-email-token");
  const { draftId: eFailId } = await createDraft({ tenantId: tD, agent: "sales", channel: "email", content: "Subject: nokey\n\nbody" });
  await approveDraft(eFailId);
  await scheduleDraft(eFailId);
  let resendCalls = 0;
  let resendAuth = "";
  const resend401: typeof fetch = async (_url: any, init: any) => {
    resendCalls++;
    resendAuth = String((init?.headers as any)?.Authorization ?? "");
    return new Response("missing api key", { status: 401 });
  };
  const sweepD = await sweepDue({
    publish: async (p) => {
      const plain = decryptChannelToken(p.token);
      return getPublisher("email").publish(
        { fetchImpl: resend401, env: { RESEND_API_KEY: "" } as unknown as NodeJS.ProcessEnv },
        { channel: p.channel, content: p.content, token: plain }
      );
    },
  });
  check("blank-key email publish fails cleanly (no crash)", sweepD.failed === 1, JSON.stringify(sweepD));
  check("blank-key email reached the API with empty Bearer", resendCalls === 1 && resendAuth === "Bearer ", resendAuth);
  const eOut = await query<{ status: string; error: string }>("SELECT status, error FROM content_publications WHERE draft_id = $1", [eFailId]);
  check("blank-key email marked draft failed with publication failed",
    (await listDraftsByTenant(tD, "failed")).find((r) => r.id === eFailId) !== undefined &&
    eOut.length === 1 && eOut[0].status === "failed" && eOut[0].error.includes("email publish 401"), JSON.stringify(eOut));

  // ==================================================================
  // 7. channels route: encrypts then persists; round-trip decrypts === original token
  // ==================================================================
  const tE = await mkTenant("t11-e", "Channel Route Tenant");
  createdTenantIds.push(tE);
  const originalToken = "oauthtoken-live-x-secret";
  // M0 (SEC-C1): the channels route is fail-closed — authenticate with a
  // fake legacy ops bearer for this section.
  const FAKE_PW = `pub-ops-${Date.now()}`;
  process.env.ADMIN_PASSWORD = FAKE_PW;
  const mkWireReq = (body: unknown) => new Request("http://localhost/api/v1/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_PW}` },
    body: JSON.stringify(body),
  });
  const w1 = await channelPOST(mkWireReq({ tenantId: tE, kind: "x", token: originalToken }));
  const j1 = await w1.json();
  const wireJson = JSON.stringify(j1);
  check("channels route returns 200 with channel id", w1.status === 200 && Number.isInteger(j1?.data?.channelId) && j1?.data?.tenantId === tE, wireJson);
  check("channels route never echoes the plaintext token", !wireJson.includes(originalToken));
  const encRows = await query<{ token_encrypted: string }>("SELECT token_encrypted FROM channels WHERE tenant_id = $1 AND kind = 'x'", [tE]);
  check("channels route stores ciphertext, never plaintext",
    encRows.length === 1 && encRows[0].token_encrypted !== originalToken && /^(v2:[^:]+:)?[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(encRows[0].token_encrypted), encRows[0].token_encrypted);
  check("channels route round-trip decrypts to original token",
    decryptChannelToken(encRows[0].token_encrypted) === originalToken);

  // re-wire upserts in place (unique tenant+kind) with a new token
  const w2 = await channelPOST(mkWireReq({ tenantId: tE, kind: "x", token: "rotated-token-777" }));
  const j2 = await w2.json();
  const encRows2 = await query<{ token_encrypted: string }>("SELECT token_encrypted FROM channels WHERE tenant_id = $1 AND kind = 'x'", [tE]);
  check("re-wire upserts one channel row and decrypts to new token",
    w2.status === 200 && encRows2.length === 1 && j2?.data?.channelId === j1?.data?.channelId &&
    encRows2[0].token_encrypted !== encRows[0].token_encrypted &&
    decryptChannelToken(encRows2[0].token_encrypted) === "rotated-token-777", JSON.stringify(encRows2));

  const badWires: { body: unknown; code: string }[] = [
    { body: { tenantId: tE, kind: "x" }, code: "INVALID_CHANNEL_WIREUP" },
    { body: { tenantId: tE, kind: "x", token: "" }, code: "INVALID_CHANNEL_WIREUP" },
    { body: { tenantId: "nope", kind: "x", token: "t" }, code: "INVALID_CHANNEL_WIREUP" },
    { body: { tenantId: tE, kind: "slack", token: "t" }, code: "INVALID_CHANNEL_KIND" },
  ];
  let allBad = true;
  for (const bw of badWires) {
    const r = await channelPOST(mkWireReq(bw.body));
    const j = await r.json();
    if (r.status !== 400 || j?.errors?.[0]?.code !== bw.code) { allBad = false; console.log(`  wire-up bad ${JSON.stringify(bw.body)} -> ${r.status} ${JSON.stringify(j)}`); }
  }
  check("channels route rejects malformed wire-ups with 400", allBad);

  // invalid JSON body (authenticated: the M0 auth gate precedes body parsing)
  const badJsonRes = await channelPOST(new Request("http://localhost/api/v1/channels", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_PW}` }, body: "{not json",
  }));
  check("channels route rejects unparseable body with 400", badJsonRes.status === 400);

  // ==================================================================
  // 8. sweep route: 401 for wrong/absent x-cron-secret with NO side effects
  // ==================================================================
  process.env.CRON_SECRET = process.env.CRON_SECRET ?? "test-cron-secret-000";
  const tF = await mkTenant("t11-f", "Sweep Route Tenant");
  createdTenantIds.push(tF);
  const routePlainTok = "route-plain-x-token";
  await addChannelsRow(tF, "x", routePlainTok);
  const { draftId: routeId } = await createDraft({ tenantId: tF, agent: "marketing", channel: "x", content: "route sweep post" });
  await approveDraft(routeId);
  await scheduleDraft(routeId);

  const mkSweepReq = (secret: string | null) => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (secret !== null) h["x-cron-secret"] = secret;
    return new Request("http://localhost/api/agents/sweep", { method: "POST", headers: h });
  };
  const stateAfter401 = async () => {
    const d = (await listDraftsByTenant(tF)).find((r) => r.id === routeId);
    return (await query<{ n: string }>("SELECT count(*)::text AS n FROM content_publications WHERE draft_id = $1", [routeId]))[0].n === "0" &&
      d?.status === "scheduled";
  };

  const rWrong = await sweepPOST(mkSweepReq("definitely-wrong-secret"));
  const jWrong = await rWrong.json();
  check("sweep route 401s a wrong secret", rWrong.status === 401 && jWrong?.errors?.[0]?.code === "UNAUTHORIZED", JSON.stringify(jWrong));
  check("401 (wrong secret) has no side effects on drafts/publications", await stateAfter401());

  const rAbsent = await sweepPOST(mkSweepReq(null));
  const jAbsent = await rAbsent.json();
  check("sweep route 401s an absent secret", rAbsent.status === 401 && jAbsent?.errors?.[0]?.code === "UNAUTHORIZED", JSON.stringify(jAbsent));
  check("401 (absent secret) has no side effects on drafts/publications", await stateAfter401());

  // correct secret: runs the sweep, route decrypts the stored token before posting
  let routePublishUrl = "";
  let routeAuth = "";
  const routeFetch: typeof fetch = async (url: any, init: any) => {
    routePublishUrl = String(url);
    routeAuth = String((init?.headers as any)?.Authorization ?? "");
    return new Response(JSON.stringify({ id: "route_x1" }), { status: 200 });
  };
  (globalThis as any).fetch = routeFetch;
  const rOk = await sweepPOST(mkSweepReq(process.env.CRON_SECRET!));
  const jOk = await rOk.json();
  check("sweep route runs with correct secret", rOk.status === 200 && Number.isInteger(jOk?.data?.posted), JSON.stringify(jOk));
  check("sweep route posted the due draft",
    (await listDraftsByTenant(tF, "posted")).find((r) => r.id === routeId) !== undefined &&
    (await query<{ status: string; external_id: string }>("SELECT status, external_id FROM content_publications WHERE draft_id = $1", [routeId]))[0]?.status === "published");
  check("route published to x endpoint", routePublishUrl === "https://api.x.com/2/tweets", routePublishUrl);
  check("route decrypted token before publishing (Bearer = plaintext, never ciphertext)",
    routeAuth === `Bearer ${routePlainTok}`, routeAuth);
  const stillEnc = (await query<{ token_encrypted: string }>("SELECT token_encrypted FROM channels WHERE tenant_id = $1 AND kind = 'x'", [tF]))[0];
  check("ciphertext alone remains in the DB", stillEnc.token_encrypted !== routePlainTok &&
    decryptChannelToken(stillEnc.token_encrypted) === routePlainTok, stillEnc.token_encrypted);
} finally {
  if (createdTenantIds.length > 0) {
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds]);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("PUBLISHERS SUITE PASS");