/**
 * Business Unit + Website service (Phase 1 M2; Phase 0.5 §5.3, §12.6).
 *
 * Target hierarchy: BusinessUnit → Website → WebsiteIntegration → Capabilities.
 * Legacy compatibility: existing `tenants` rows map 1:1 into business_units
 * via business_units.legacy_tenant_id (UNIQUE); legacy readers keep working
 * and new BUs/websites require configuration rows only — never code.
 */
import { query } from "./db";
import { buScopeForUser } from "./auth/rbac";

export interface BusinessUnitRow {
  id: number;
  slug: string;
  name: string;
  status: "active" | "suspended";
  brandVoice: string;
  persona: string;
  audience: string;
  contactEmail: string | null;
  metadata: Record<string, unknown>;
  legacyTenantId: number | null;
  websiteCount: number;
  createdAt: string;
}

export interface WebsiteRow {
  id: number;
  businessUnitId: number;
  slug: string;
  name: string;
  domain: string | null;
  environment: "production" | "staging" | "development";
  status: "active" | "inactive" | "pending";
  defaultLocale: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ---------- business units ----------

export async function listBusinessUnits(): Promise<BusinessUnitRow[]> {
  const rows = await query<any>(
    `SELECT bu.id, bu.slug, bu.name, bu.status, bu.brand_voice, bu.persona, bu.audience,
            bu.contact_email, bu.metadata, bu.legacy_tenant_id, bu.created_at,
            (SELECT count(*)::int FROM websites w WHERE w.business_unit_id = bu.id) AS website_count
     FROM business_units bu
     ORDER BY bu.id ASC`
  );
  return rows.map(mapBu);
}

function mapBu(r: any): BusinessUnitRow {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    brandVoice: r.brand_voice,
    persona: r.persona,
    audience: r.audience,
    contactEmail: r.contact_email,
    metadata: r.metadata ?? {},
    legacyTenantId: r.legacy_tenant_id,
    websiteCount: r.website_count,
    createdAt: r.created_at,
  };
}

export async function getBusinessUnit(id: number): Promise<BusinessUnitRow | null> {
  const rows = await query<any>(
    `SELECT bu.id, bu.slug, bu.name, bu.status, bu.brand_voice, bu.persona, bu.audience,
            bu.contact_email, bu.metadata, bu.legacy_tenant_id, bu.created_at,
            (SELECT count(*)::int FROM websites w WHERE w.business_unit_id = bu.id) AS website_count
     FROM business_units bu WHERE bu.id = $1`,
    [id]
  );
  return rows.length > 0 ? mapBu(rows[0]) : null;
}

export interface CreateBuParams {
  name: string;
  slug?: string;
  brandVoice?: string;
  persona?: string;
  audience?: string;
  contactEmail?: string;
  metadata?: Record<string, unknown>;
}

export async function createBusinessUnit(p: CreateBuParams): Promise<BusinessUnitRow> {
  const slug = slugify(p.slug || p.name);
  if (!slug) throw new BuValidationError("slug required");
  const rows = await query<any>(
    `INSERT INTO business_units (slug, name, brand_voice, persona, audience, contact_email, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [slug, p.name, p.brandVoice ?? "", p.persona ?? "", p.audience ?? "", p.contactEmail ?? null, JSON.stringify(p.metadata ?? {})]
  ).catch((e) => {
    if ((e as { code?: string }).code === "23505") throw new BuValidationError("slug already exists");
    throw e;
  });
  const bu = await getBusinessUnit(rows[0].id);
  if (!bu) throw new Error("business unit vanished after insert");
  return bu;
}

export interface UpdateBuParams {
  name?: string;
  status?: "active" | "suspended";
  brandVoice?: string;
  persona?: string;
  audience?: string;
  contactEmail?: string | null;
  metadata?: Record<string, unknown>;
}

export async function updateBusinessUnit(id: number, p: UpdateBuParams): Promise<BusinessUnitRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (p.name !== undefined) add("name", p.name);
  if (p.status !== undefined) add("status", p.status);
  if (p.brandVoice !== undefined) add("brand_voice", p.brandVoice);
  if (p.persona !== undefined) add("persona", p.persona);
  if (p.audience !== undefined) add("audience", p.audience);
  if (p.contactEmail !== undefined) add("contact_email", p.contactEmail);
  if (p.metadata !== undefined) add("metadata", JSON.stringify(p.metadata));
  if (sets.length === 0) return getBusinessUnit(id);
  sets.push("updated_at = now()");
  await query(`UPDATE business_units SET ${sets.join(", ")} WHERE id = $1`, params);
  return getBusinessUnit(id);
}

// ---------- websites ----------

export async function listWebsites(businessUnitId?: number): Promise<WebsiteRow[]> {
  const rows = businessUnitId
    ? await query<any>(`SELECT * FROM websites WHERE business_unit_id = $1 ORDER BY id ASC`, [businessUnitId])
    : await query<any>(`SELECT * FROM websites ORDER BY id ASC`);
  return rows.map(mapWebsite);
}

export async function listWebsitesForBusinessUnits(businessUnitIds: number[]): Promise<WebsiteRow[]> {
  if (businessUnitIds.length === 0) return [];
  const rows = await query<any>(
    `SELECT * FROM websites WHERE business_unit_id = ANY($1::bigint[]) ORDER BY id ASC`,
    [businessUnitIds]
  );
  return rows.map(mapWebsite);
}

function mapWebsite(r: any): WebsiteRow {
  return {
    id: r.id,
    businessUnitId: r.business_unit_id,
    slug: r.slug,
    name: r.name,
    domain: r.domain,
    environment: r.environment,
    status: r.status,
    defaultLocale: r.default_locale,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
  };
}

export interface CreateWebsiteParams {
  businessUnitId: number;
  name: string;
  slug?: string;
  domain?: string;
  environment?: "production" | "staging" | "development";
  defaultLocale?: string;
  metadata?: Record<string, unknown>;
}

export async function createWebsite(p: CreateWebsiteParams): Promise<WebsiteRow> {
  const slug = slugify(p.slug || p.name);
  if (!slug) throw new BuValidationError("slug required");
  const rows = await query<{ id: number }>(
    `INSERT INTO websites (business_unit_id, slug, name, domain, environment, default_locale, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id`,
    [p.businessUnitId, slug, p.name, p.domain ?? null, p.environment ?? "production", p.defaultLocale ?? "en", JSON.stringify(p.metadata ?? {})]
  ).catch((e) => {
    if ((e as { code?: string }).code === "23505") throw new BuValidationError("slug already exists");
    if ((e as { code?: string }).code === "23503") throw new BuValidationError("unknown business unit");
    throw e;
  });
  const website = await getWebsite(rows[0].id);
  if (!website) throw new Error("website vanished after insert");
  return website;
}

export async function getWebsite(id: number): Promise<WebsiteRow | null> {
  const rows = await query<any>("SELECT * FROM websites WHERE id = $1", [id]);
  return rows.length > 0 ? mapWebsite(rows[0]) : null;
}

export interface UpdateWebsiteParams {
  name?: string;
  domain?: string | null;
  environment?: "production" | "staging" | "development";
  status?: "active" | "inactive" | "pending";
  defaultLocale?: string;
  metadata?: Record<string, unknown>;
}

export async function updateWebsite(id: number, p: UpdateWebsiteParams): Promise<WebsiteRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (p.name !== undefined) add("name", p.name);
  if (p.domain !== undefined) add("domain", p.domain);
  if (p.environment !== undefined) add("environment", p.environment);
  if (p.status !== undefined) add("status", p.status);
  if (p.defaultLocale !== undefined) add("default_locale", p.defaultLocale);
  if (p.metadata !== undefined) add("metadata", JSON.stringify(p.metadata));
  if (sets.length === 0) return getWebsite(id);
  sets.push("updated_at = now()");
  await query(`UPDATE websites SET ${sets.join(", ")} WHERE id = $1`, params);
  return getWebsite(id);
}

// ---------- legacy tenant mapping ----------

/** Legacy tenant id for a BU (null when the BU was created post-migration). */
export async function legacyTenantIdForBu(businessUnitId: number): Promise<number | null> {
  const rows = await query<{ legacy_tenant_id: number | null }>(
    "SELECT legacy_tenant_id FROM business_units WHERE id = $1",
    [businessUnitId]
  );
  return rows[0]?.legacy_tenant_id ?? null;
}

/** BU holding a legacy tenant mapping (null for tenants created post-migration). */
export async function buForLegacyTenantId(tenantId: number): Promise<BusinessUnitRow | null> {
  const rows = await query<{ id: number }>(
    "SELECT id FROM business_units WHERE legacy_tenant_id = $1",
    [tenantId]
  );
  return rows.length > 0 ? getBusinessUnit(rows[0].id) : null;
}

/**
 * Idempotent ensure-mapping used by the demo seed: guarantees a BU (+ default
 * website) exists for a legacy tenant row. New tenants created by the seed
 * after migration 007 ran get the same 1:1 treatment here.
 */
export async function ensureLegacyMapping(tenantId: number): Promise<{ businessUnitId: number; websiteId: number }> {
  let bu = await buForLegacyTenantId(tenantId);
  if (!bu) {
    const t = await query<{ slug: string; name: string }>("SELECT slug, name FROM tenants WHERE id = $1", [tenantId]);
    if (t.length === 0) throw new Error(`unknown tenant ${tenantId}`);
    const cfg = await query<{ brand_voice: string; persona: string; audience: string }>(
      "SELECT brand_voice, persona, audience FROM tenant_config WHERE tenant_id = $1",
      [tenantId]
    );
    const slug = slugify(t[0].slug) || `tenant-${tenantId}`;
    const inserted = await query<{ id: number }>(
      `INSERT INTO business_units (slug, name, brand_voice, persona, audience, legacy_tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (legacy_tenant_id) DO NOTHING
       RETURNING id`,
      [slug, t[0].name, cfg[0]?.brand_voice ?? "", cfg[0]?.persona ?? "", cfg[0]?.audience ?? "", tenantId]
    ).catch((e) => {
      if ((e as { code?: string }).code === "23505" && (e as { constraint?: string }).constraint?.includes("slug")) {
        // slug taken by a manual BU: fall back to a suffixed legacy slug
        return query<{ id: number }>(
          `INSERT INTO business_units (slug, name, brand_voice, persona, audience, legacy_tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [`${slug}-legacy-${tenantId}`, t[0].name, cfg[0]?.brand_voice ?? "", cfg[0]?.persona ?? "", cfg[0]?.audience ?? "", tenantId]
        );
      }
      throw e;
    });
    if (inserted.length === 0) {
      bu = await buForLegacyTenantId(tenantId);
    } else {
      bu = await getBusinessUnit(inserted[0].id);
    }
  }
  if (!bu) throw new Error(`could not ensure business unit for tenant ${tenantId}`);

  let websites = await listWebsites(bu.id);
  if (websites.length === 0) {
    await query(
      `INSERT INTO websites (business_unit_id, slug, name, environment, status)
       VALUES ($1, $2, $3, 'production', 'active')
       ON CONFLICT (slug) DO NOTHING`,
      [bu.id, `${bu.slug}-primary-${bu.id}`.slice(0, 60), `${bu.name} primary site`]
    );
    websites = await listWebsites(bu.id);
  }
  return { businessUnitId: bu.id, websiteId: websites[0]?.id ?? 0 };
}

/**
 * Legacy tenant ids a user may read, derived from BU scope. "all" passes
 * through untouched (legacy bearer / global roles).
 */
export async function permittedLegacyTenantIds(userId: number): Promise<{ kind: "all" | "list"; tenantIds: number[] }> {
  const scope = await buScopeForUser(userId);
  if (scope.kind === "all") return { kind: "all", tenantIds: [] };
  if (scope.businessUnitIds.length === 0) return { kind: "list", tenantIds: [] };
  const rows = await query<{ legacy_tenant_id: number | null }>(
    "SELECT legacy_tenant_id FROM business_units WHERE id = ANY($1::bigint[])",
    [scope.businessUnitIds]
  );
  return { kind: "list", tenantIds: rows.map((r) => r.legacy_tenant_id).filter((v): v is number => v != null) };
}

export class BuValidationError extends Error {}
