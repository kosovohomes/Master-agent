/**
 * Add-Website onboarding orchestrator (Phase 14 — roadmap P13, §121–§123).
 *
 * ONE PLATFORM + CONFIGURATION + CONNECTORS = MANY WEBSITES (§120): this
 * module executes the §121 wizard sequence — information → agents →
 * integrations → knowledge → permissions → autonomy → activate — purely as
 * configuration rows. No code, migration, or redeploy is involved in adding
 * a site; the acceptance gate (§121–§123) is that onboarding a new site is
 * configuration only.
 *
 * Design invariants:
 *  - VALIDATE FIRST: every input is checked before the first write, so a
 *    rejected onboarding touches nothing (mirrors the M0 fail-closed bias).
 *  - RESUMABLE: every step is find-or-create keyed on natural identity
 *    (BU slug, website slug, connector type, knowledge (kind, ref),
 *    capability upsert). Re-submitting the same payload reports "existing"
 *    for completed steps instead of duplicating or failing.
 *  - REVEAL-ONCE: connector credentials (webhook signing secret, widget site
 *    key) are returned exactly once — on the CREATE call only. A resumed
 *    onboarding never re-reveals; the admin rotates instead.
 *  - AUDITED: every mutating step writes its own audit event; connector
 *    credentials never enter audit metadata.
 *  - FAILURE ISOLATION (§144): steps are independent — a knowledge ref that
 *    fails validation is reported per-step and does not poison connectors or
 *    grants. Site runtime isolation itself is proven by construction in the
 *    connector event router (per-delivery scoping, no shared state).
 *
 * Autonomy note: §121 lists "Set autonomy". Autonomy LEVELS arrive at P15
 * (§45); until then the only legal value is the standing invariant
 * "approval_required" (generation autonomous, publication human-gated),
 * recorded as configuration metadata for P15 to consume.
 */
import { query } from "../db";
import { slugify, createBusinessUnit, createWebsite, updateWebsite, getBusinessUnit, BuValidationError } from "../bu";
import { createKnowledgeSource, KnowledgeSourceError } from "../knowledge/service";
import {
  createWebsiteConnector,
  grantWebsiteCapability,
  ConnectorError,
} from "./service";
import { CONNECTOR_CAPABILITIES, CONNECTOR_TYPES, type ConnectorCapability } from "./types";
import { writeAudit } from "../audit";

export class OnboardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OnboardError";
  }
}

export const AUTONOMY_VALUES = ["approval_required"] as const;
export type AutonomyValue = (typeof AUTONOMY_VALUES)[number];

export interface OnboardKnowledgeInput {
  kind: string;
  ref: string;
  title?: string;
  jurisdiction?: string | null;
  language?: string | null;
  accessLevel?: "public" | "internal" | "confidential";
  refreshFrequency?: "manual" | "daily" | "weekly";
  authorityLevel?: number;
}

export interface OnboardPayload {
  businessUnit: {
    /** Use an existing BU (id wins over slug). Omit both to create one. */
    id?: number;
    slug?: string;
    name?: string;
    brandVoice?: string;
    persona?: string;
    audience?: string;
    contactEmail?: string;
  };
  website: {
    name: string;
    slug?: string;
    domain?: string;
    environment?: "production" | "staging" | "development";
    defaultLocale?: string;
    /** §11 configuration fields — recorded as website metadata. */
    businessType?: string;
    jurisdiction?: string;
    market?: string;
    language?: string;
    audience?: string;
    brand?: string;
  };
  /** Agent slugs selected for this site (validated against the registry). */
  agents?: string[];
  /** Connectors to wire up. */
  integrations?: { webhook?: boolean; widget?: boolean };
  /** Optional seed knowledge sources (configuration only — no fetch runs). */
  knowledge?: OnboardKnowledgeInput[];
  /** Capability grants (§12). */
  capabilities?: string[];
  /** Only "approval_required" is legal until P15 delivers levels (§45). */
  autonomy?: AutonomyValue;
  /** Default true — the §121 flow ends with Activate. */
  activate?: boolean;
}

export interface OnboardStepResult {
  step: "business_unit" | "website" | "agents" | "connector" | "knowledge" | "capabilities" | "autonomy" | "activate";
  status: "created" | "existing" | "granted" | "skipped" | "failed";
  ref?: string;
  id?: number;
  detail?: string;
}

export interface OnboardResult {
  businessUnitId: number;
  websiteId: number;
  websiteSlug: string;
  websiteStatus: string;
  steps: OnboardStepResult[];
  /** Reveal-once — present ONLY when the connector was created in this call. */
  signingSecret?: string;
  /** Reveal-once — present ONLY when the connector was created in this call. */
  siteKey?: string;
}

interface ValidatedOnboard {
  bu: NonNullable<OnboardPayload["businessUnit"]>;
  website: NonNullable<OnboardPayload["website"]>;
  agents: string[];
  connectors: string[];
  knowledgeList: OnboardKnowledgeInput[];
  capabilities: ConnectorCapability[];
  autonomy: AutonomyValue;
  activate: boolean;
}

/** Validate the whole payload up front — a rejected onboarding writes nothing. */
export async function validateOnboardPayload(p: OnboardPayload): Promise<ValidatedOnboard> {
  if (!p || typeof p !== "object") throw new OnboardError("INVALID_PAYLOAD", "body must be an object");
  if (!p.website || typeof p.website.name !== "string" || p.website.name.trim() === "") {
    throw new OnboardError("WEBSITE_NAME_REQUIRED", "website.name is required");
  }
  const wSlug = slugify(p.website.slug || p.website.name);
  if (!wSlug) throw new OnboardError("INVALID_SLUG", "website slug resolves to an empty string");

  const bu = p.businessUnit ?? {};
  const creatingBu = bu.id === undefined && bu.slug === undefined;
  if (creatingBu && (typeof bu.name !== "string" || bu.name.trim() === "")) {
    throw new OnboardError("BU_NAME_REQUIRED", "businessUnit.name is required when not referencing an existing unit");
  }
  if (bu.slug !== undefined && bu.id === undefined && !slugify(bu.slug)) {
    throw new OnboardError("INVALID_SLUG", "businessUnit.slug resolves to an empty string");
  }

  const agents = [...new Set((p.agents ?? []).map((a) => String(a).trim()).filter(Boolean))];
  if (agents.length > 0) {
    const known = await query<{ slug: string }>(
      `SELECT slug FROM agents WHERE slug = ANY($1::text[]) AND status = 'active'`,
      [agents]
    );
    const knownSet = new Set(known.map((k) => k.slug));
    const unknown = agents.filter((a) => !knownSet.has(a));
    if (unknown.length > 0) {
      throw new OnboardError("UNKNOWN_AGENT", `unknown or inactive agent(s): ${unknown.join(", ")}`);
    }
  }

  const connectors: string[] = [];
  if (p.integrations?.webhook) connectors.push("webhook");
  if (p.integrations?.widget) connectors.push("widget");
  for (const t of connectors) {
    if (!(CONNECTOR_TYPES as readonly string[]).includes(t)) {
      throw new OnboardError("INVALID_CONNECTOR_TYPE", `connector type must be one of ${CONNECTOR_TYPES.join(", ")}`);
    }
  }

  const knowledgeList = (p.knowledge ?? []).map((k) => ({
    kind: String(k.kind ?? "").trim(),
    ref: String(k.ref ?? "").trim(),
    title: k.title !== undefined ? String(k.title).slice(0, 200) : undefined,
    jurisdiction: k.jurisdiction ?? null,
    language: k.language ?? null,
    accessLevel: k.accessLevel ?? ("public" as const),
    refreshFrequency: k.refreshFrequency ?? ("manual" as const),
    authorityLevel: k.authorityLevel ?? 3,
  }));
  for (const k of knowledgeList) {
    if (!["sitemap", "upload", "api", "rss", "url", "github", "db"].includes(k.kind)) {
      throw new OnboardError("INVALID_KNOWLEDGE_KIND", `knowledge.kind must be one of sitemap, upload, api, rss, url, github, db (got "${k.kind}")`);
    }
    if (k.ref === "") throw new OnboardError("KNOWLEDGE_REF_REQUIRED", "every knowledge entry needs a ref");
  }

  const capabilities = [...new Set(p.capabilities ?? [])] as ConnectorCapability[];
  for (const c of capabilities) {
    if (!(CONNECTOR_CAPABILITIES as readonly string[]).includes(c)) {
      throw new OnboardError("INVALID_CAPABILITY", `capability must be one of ${CONNECTOR_CAPABILITIES.join(", ")}`);
    }
  }

  const autonomy = p.autonomy ?? "approval_required";
  if (!(AUTONOMY_VALUES as readonly string[]).includes(autonomy)) {
    throw new OnboardError("INVALID_AUTONOMY", `autonomy must be one of ${AUTONOMY_VALUES.join(", ")} (levels arrive at P15)`);
  }

  return {
    bu,
    website: { ...p.website, name: p.website.name.trim() },
    agents,
    connectors,
    knowledgeList,
    capabilities,
    autonomy,
    activate: p.activate !== false,
  };
}

/** Execute the §121 sequence. Assumes validation already ran. */
export async function runOnboard(
  v: ValidatedOnboard,
  audit: { actorId: number | null; requestId: string; ip?: string }
): Promise<OnboardResult> {
  const steps: OnboardStepResult[] = [];
  const auditStep = async (action: string, resourceId: number | null, metadata: Record<string, unknown>) => {
    await writeAudit({
      actorType: "user",
      actorId: audit.actorId,
      action,
      resource: "onboarding",
      resourceId,
      result: "success",
      requestId: audit.requestId,
      ip: audit.ip,
      metadata,
    });
  };

  // ---- step 1: business unit (find-or-create) ----
  let buId: number;
  let buStatus: OnboardStepResult["status"];
  if (v.bu.id !== undefined) {
    const bu = await getBusinessUnit(v.bu.id);
    if (!bu) throw new OnboardError("UNKNOWN_BUSINESS_UNIT", `business unit ${v.bu.id} not found`);
    buId = bu.id;
    buStatus = "existing";
  } else {
    const slug = slugify(v.bu.slug || (v.bu.name as string));
    const existing = await query<{ id: number }>(`SELECT id FROM business_units WHERE slug = $1`, [slug]);
    if (existing.length > 0) {
      buId = existing[0].id;
      buStatus = "existing";
    } else {
      const created = await createBusinessUnit({
        name: v.bu.name as string,
        slug,
        brandVoice: v.bu.brandVoice,
        persona: v.bu.persona,
        audience: v.bu.audience,
        contactEmail: v.bu.contactEmail,
      });
      buId = created.id;
      buStatus = "created";
      // Provision the 1:1 tenant identity (the reverse of the migration-007
      // backfill): tenant-keyed surfaces (usage cap, tenant_config, RAG
      // fallback, widget-by-tenant) keep working for pure-config BUs.
      let tenantId: number | null = null;
      try {
        const [t] = await query<{ id: number }>(
          `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
          [slug, created.name]
        );
        tenantId = t.id;
      } catch {
        // slug collision with an existing tenant — deterministically suffix it
        const [t] = await query<{ id: number }>(
          `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
          [`${slug}-bu${created.id}`, created.name]
        );
        tenantId = t.id;
      }
      await query(`UPDATE business_units SET legacy_tenant_id = $2 WHERE id = $1 AND legacy_tenant_id IS NULL`, [created.id, tenantId]);
      await auditStep("onboard.business_unit", created.id, { slug, name: created.name, tenantId });
    }
  }
  steps.push({ step: "business_unit", status: buStatus, id: buId, ref: `bu:${buId}` });

  // ---- step 2: website (find-or-create by slug) + §11 configuration metadata ----
  const wSlug = slugify(v.website.slug || v.website.name);
  const existingSite = await query<{ id: number; status: string; business_unit_id: number }>(
    `SELECT id, status, business_unit_id FROM websites WHERE slug = $1`,
    [wSlug]
  );
  let websiteId: number;
  let websiteStatus: string;
  let siteStep: OnboardStepResult["status"];
  if (existingSite.length > 0) {
    websiteId = existingSite[0].id;
    websiteStatus = existingSite[0].status;
    siteStep = "existing";
    if (existingSite[0].business_unit_id !== buId) {
      throw new OnboardError(
        "WEBSITE_BU_MISMATCH",
        `website "${wSlug}" already exists under a different business unit — onboard it without businessUnit, or choose another slug`
      );
    }
  } else {
    const created = await createWebsite({
      businessUnitId: buId,
      name: v.website.name,
      slug: wSlug,
      domain: v.website.domain,
      environment: v.website.environment,
      defaultLocale: v.website.defaultLocale,
      metadata: {
        onboarding: {
          source: "add_website_wizard",
          recordedAt: new Date().toISOString(),
          businessType: v.website.businessType ?? null,
          jurisdiction: v.website.jurisdiction ?? null,
          market: v.website.market ?? null,
          language: v.website.language ?? v.website.defaultLocale ?? null,
          audience: v.website.audience ?? null,
          brand: v.website.brand ?? null,
          agents: v.agents,
          autonomy: v.autonomy,
        },
      },
    });
    websiteId = created.id;
    websiteStatus = created.status;
    siteStep = "created";
    await auditStep("onboard.website", created.id, { slug: created.slug, businessUnitId: buId });
  }
  steps.push({ step: "website", status: siteStep, id: websiteId, ref: wSlug });

  // ---- step 3: agents (configuration selection — validated above) ----
  steps.push({
    step: "agents",
    status: v.agents.length > 0 ? (siteStep === "created" ? "created" : "existing") : "skipped",
    detail: v.agents.length > 0 ? v.agents.join(", ") : "no agents selected",
  });

  // ---- step 4: integrations (connectors, reveal-once credentials) ----
  let signingSecret: string | undefined;
  let siteKey: string | undefined;
  for (const type of v.connectors) {
    try {
      const res = await createWebsiteConnector({ websiteId, type });
      if (res.signingSecret) signingSecret = res.signingSecret;
      if (res.siteKey) siteKey = res.siteKey;
      steps.push({ step: "connector", status: "created", id: res.connector.id, ref: type });
      await auditStep("onboard.connector", res.connector.id, { websiteId, type });
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "CONNECTOR_EXISTS") {
        steps.push({ step: "connector", status: "existing", ref: type, detail: "already wired — rotate to obtain a new credential" });
        continue;
      }
      throw e;
    }
  }

  // ---- step 5: knowledge (find-or-create by (website, kind, ref)) ----
  for (const k of v.knowledgeList) {
    try {
      const existing = await query<{ id: number }>(
        `SELECT id FROM knowledge_sources WHERE website_id = $1 AND kind = $2 AND ref = $3`,
        [websiteId, k.kind, k.ref]
      );
      if (existing.length > 0) {
        steps.push({ step: "knowledge", status: "existing", id: existing[0].id, ref: k.ref });
        continue;
      }
      const src = await createKnowledgeSource({
        businessUnitId: buId,
        websiteId,
        kind: k.kind as never,
        ref: k.ref,
        title: k.title,
        jurisdiction: k.jurisdiction,
        language: k.language,
        accessLevel: k.accessLevel,
        refreshFrequency: k.refreshFrequency,
        authorityLevel: k.authorityLevel,
      });
      steps.push({ step: "knowledge", status: "created", id: src.id, ref: k.ref });
      await auditStep("onboard.knowledge", src.id, { websiteId, kind: k.kind, ref: k.ref });
    } catch (e) {
      if (e instanceof KnowledgeSourceError) {
        steps.push({ step: "knowledge", status: "failed", ref: k.ref, detail: e.message });
        continue; // §144: one bad source never poisons the rest of onboarding
      }
      throw e;
    }
  }

  // ---- step 6: capability grants (§12 — live enforcement surface) ----
  for (const c of v.capabilities) {
    const grant = await grantWebsiteCapability(websiteId, c, true);
    steps.push({ step: "capabilities", status: "granted", ref: c, detail: grant.enabled ? "enabled" : "disabled" });
  }
  if (v.capabilities.length > 0) {
    await auditStep("onboard.capabilities", websiteId, { websiteId, capabilities: v.capabilities });
  }

  // ---- step 7: autonomy + activate ----
  if (siteStep === "existing" && v.activate !== false) {
    // record autonomy on an existing site's metadata too (jsonb merge)
    await query(
      `UPDATE websites SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{onboarding,autonomy}', to_jsonb($2::text), true), updated_at = now() WHERE id = $1`,
      [websiteId, v.autonomy]
    );
    steps.push({ step: "autonomy", status: "existing", ref: v.autonomy });
  } else {
    steps.push({ step: "autonomy", status: siteStep === "created" ? "created" : "skipped", ref: v.autonomy });
  }
  if (v.activate) {
    if (websiteStatus !== "active") {
      await updateWebsite(websiteId, { status: "active" });
      websiteStatus = "active";
      steps.push({ step: "activate", status: "created", id: websiteId });
    } else {
      steps.push({ step: "activate", status: "existing", id: websiteId, detail: "already active" });
    }
    await auditStep("onboard.activate", websiteId, { websiteId, status: websiteStatus });
  } else {
    steps.push({ step: "activate", status: "skipped", detail: "activate=false — site left as-is" });
  }

  return {
    businessUnitId: buId,
    websiteId,
    websiteSlug: wSlug,
    websiteStatus,
    steps,
    signingSecret,
    siteKey,
  };
}

/** Validate + execute + normalize errors for the route layer. */
export async function onboardWebsite(p: OnboardPayload, audit: { actorId: number | null; requestId: string; ip?: string }): Promise<OnboardResult> {
  const v = await validateOnboardPayload(p);
  try {
    return await runOnboard(v, audit);
  } catch (e) {
    if (e instanceof BuValidationError) throw new OnboardError("BU_VALIDATION", e.message);
    throw e;
  }
}
