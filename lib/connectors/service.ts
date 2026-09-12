/**
 * Connector service (Phase 6): CRUD over website_integrations rows of
 * integration_type='webhook' + capability grants (website_capabilities) +
 * the connector_deliveries receipt log with replay semantics.
 *
 * Secret handling (SEC-L4 / §77):
 *  - the signing secret is generated here, encrypted at rest with the
 *    AES-256-GCM channel envelope (lib/channels.ts), and returned to the
 *    admin caller EXACTLY ONCE per create/rotate — never stored in
 *    plaintext, never logged, never audited;
 *  - rotation keeps the previous secret (encrypted) for a bounded window so
 *    senders can cut over without a delivery gap (verify order: current →
 *    previous-in-window).
 *
 * Replay semantics on connector_deliveries (UNIQUE (website_id, delivery_id)):
 *  - first sight of a (website, delivery) row inserts it — processed;
 *  - a row whose status='failed' may be RE-RECORDED by a sender retry with
 *    the same delivery id (webhook retries must not be permanently lost);
 *  - any other conflict is a replay of an already-accepted delivery → 409.
 */
import { query } from "../db";
import { encryptChannelToken, decryptChannelToken } from "../channels";
import { generateSigningSecret } from "./crypto";
import {
  CONNECTOR_CAPABILITIES,
  CONNECTOR_TYPES,
  isGrantableCapability,
  type ConnectorCapability,
  type ConnectorRow,
  type DeliveryRow,
} from "./types";

export class ConnectorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ConnectorError";
  }
}

const CONNECTOR_COLUMNS = `wi.id, wi.website_id, wi.integration_type, wi.status,
  wi.config, wi.signing_algo, wi.rotated_at, wi.last_event_at, wi.display_name,
  wi.created_at, w.name AS website_name, w.slug AS website_slug,
  w.business_unit_id`;

function mapConnector(r: any): ConnectorRow {
  return {
    id: Number(r.id),
    websiteId: Number(r.website_id),
    businessUnitId: Number(r.business_unit_id),
    websiteName: r.website_name,
    websiteSlug: r.website_slug,
    type: r.integration_type,
    displayName: r.display_name ?? null,
    status: r.status,
    signingAlgo: r.signing_algo ?? "hmac-sha256",
    capabilities: [],
    lastEventAt: r.last_event_at ?? null,
    rotatedAt: r.rotated_at ?? null,
    createdAt: r.created_at,
    deliveries24h: 0,
    failed24h: 0,
  };
}

/** All webhook connectors across websites, with grants + 24h delivery stats. */
export async function listConnectors(): Promise<ConnectorRow[]> {
  const rows = await query<any>(
    `SELECT ${CONNECTOR_COLUMNS},
       COALESCE((SELECT count(*)::int FROM connector_deliveries d
        WHERE d.integration_id = wi.id AND d.created_at > now() - interval '24 hours'), 0) AS deliveries_24h,
       COALESCE((SELECT count(*)::int FROM connector_deliveries d
        WHERE d.integration_id = wi.id AND d.status = 'failed' AND d.created_at > now() - interval '24 hours'), 0) AS failed_24h
     FROM website_integrations wi
     JOIN websites w ON w.id = wi.website_id
     WHERE wi.integration_type = ANY($1::text[])
     ORDER BY wi.id ASC`,
    [[...CONNECTOR_TYPES]]
  );
  const grants = await query<{ website_id: string; capability: string }>(
    `SELECT website_id::text, capability FROM website_capabilities WHERE enabled = true ORDER BY capability ASC`
  );
  const byWebsite = new Map<string, ConnectorCapability[]>();
  for (const g of grants) {
    if (!isGrantableCapability(g.capability)) continue;
    const list = byWebsite.get(g.website_id) ?? [];
    list.push(g.capability);
    byWebsite.set(g.website_id, list);
  }
  return rows.map((r) => {
    const c = mapConnector(r);
    c.deliveries24h = Number(r.deliveries_24h ?? 0);
    c.failed24h = Number(r.failed_24h ?? 0);
    c.capabilities = byWebsite.get(String(c.websiteId)) ?? [];
    return c;
  });
}

export async function getConnector(id: number): Promise<ConnectorRow | null> {
  const rows = await query<any>(
    `SELECT ${CONNECTOR_COLUMNS}
     FROM website_integrations wi
     JOIN websites w ON w.id = wi.website_id
     WHERE wi.id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const c = mapConnector(rows[0]);
  const grants = await query<{ capability: string }>(
    `SELECT capability FROM website_capabilities WHERE website_id = $1 AND enabled = true ORDER BY capability ASC`,
    [c.websiteId]
  );
  c.capabilities = grants.map((g) => g.capability as ConnectorCapability);
  return c;
}

/** The active connector of `type` for one website (isolation: scoped by website_id). */
export async function getWebsiteConnector(
  websiteId: number,
  type: string = "webhook"
): Promise<(ConnectorRow & { config: Record<string, unknown> }) | null> {
  const rows = await query<any>(
    `SELECT ${CONNECTOR_COLUMNS}, wi.config
     FROM website_integrations wi
     JOIN websites w ON w.id = wi.website_id
     WHERE wi.website_id = $1 AND wi.integration_type = $2`,
    [websiteId, type]
  );
  if (rows.length === 0) return null;
  return { ...mapConnector(rows[0]), config: rows[0].config ?? {} };
}

export interface CreateConnectorResult {
  connector: ConnectorRow;
  /** The raw signing secret — shown to the admin EXACTLY ONCE. */
  signingSecret: string;
}

export async function createWebsiteConnector(p: {
  websiteId: number;
  type?: string;
  displayName?: string | null;
}): Promise<CreateConnectorResult> {
  const type = p.type ?? "webhook";
  if (!(CONNECTOR_TYPES as readonly string[]).includes(type)) {
    throw new ConnectorError("INVALID_TYPE", `connector type must be one of ${CONNECTOR_TYPES.join(", ")}`);
  }
  const site = await query<{ id: number }>("SELECT id FROM websites WHERE id = $1", [p.websiteId]);
  if (site.length === 0) throw new ConnectorError("UNKNOWN_WEBSITE", `unknown website ${p.websiteId}`);

  const secret = generateSigningSecret();
  const rows = await query<{ id: number }>(
    `INSERT INTO website_integrations (website_id, integration_type, status, config, credentials_encrypted, display_name)
     VALUES ($1, $2, 'active', '{}'::jsonb, $3, $4)
     ON CONFLICT (website_id, integration_type) DO NOTHING
     RETURNING id`,
    [p.websiteId, type, encryptChannelToken(secret), p.displayName ?? null]
  );
  if (rows.length === 0) {
    throw new ConnectorError("CONNECTOR_EXISTS", `website ${p.websiteId} already has a ${type} connector — rotate instead`);
  }
  const connector = await getConnector(rows[0].id);
  if (!connector) throw new ConnectorError("VANISHED", "connector vanished after insert");
  return { connector, signingSecret: secret };
}

/**
 * Zero-downtime rotation (§77): current secret → previous (kept for the
 * rotation window), new secret becomes current. Returns the new secret ONCE.
 */
export async function rotateConnectorSecret(id: number): Promise<CreateConnectorResult> {
  const rows = await query<{ credentials_encrypted: string | null }>(
    `SELECT credentials_encrypted FROM website_integrations WHERE id = $1 AND integration_type = 'webhook'`,
    [id]
  );
  if (rows.length === 0 || !rows[0].credentials_encrypted) {
    throw new ConnectorError("NOT_FOUND", `connector not found: ${id}`);
  }
  const secret = generateSigningSecret();
  await query(
    `UPDATE website_integrations
     SET previous_credentials_encrypted = credentials_encrypted,
         credentials_encrypted = $2,
         rotated_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [id, encryptChannelToken(secret)]
  );
  const connector = await getConnector(id);
  if (!connector) throw new ConnectorError("VANISHED", "connector vanished after rotate");
  return { connector, signingSecret: secret };
}

export async function setConnectorStatus(
  id: number,
  status: "active" | "disabled" | "error"
): Promise<ConnectorRow | null> {
  await query(`UPDATE website_integrations SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  return getConnector(id);
}

export async function deleteConnector(id: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `DELETE FROM website_integrations WHERE id = $1 AND integration_type = 'webhook' RETURNING id`,
    [id]
  );
  return rows.length > 0;
}

/** Decrypted secrets for verification (current first, previous second). */
export async function connectorSecrets(integrationId: number): Promise<{
  current: string | null;
  previous: string | null;
  rotatedAt: string | null;
}> {
  const rows = await query<{
    credentials_encrypted: string | null;
    previous_credentials_encrypted: string | null;
    rotated_at: string | null;
  }>(
    `SELECT credentials_encrypted, previous_credentials_encrypted, rotated_at
     FROM website_integrations WHERE id = $1`,
    [integrationId]
  );
  if (rows.length === 0) return { current: null, previous: null, rotatedAt: null };
  const r = rows[0];
  return {
    current: r.credentials_encrypted ? decryptChannelToken(r.credentials_encrypted) : null,
    previous: r.previous_credentials_encrypted ? decryptChannelToken(r.previous_credentials_encrypted) : null,
    rotatedAt: r.rotated_at ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* capability grants (§394 — website_capabilities, migration 008)      */
/* ------------------------------------------------------------------ */

export interface CapabilityGrant {
  capability: string;
  enabled: boolean;
  updatedAt: string;
}

export async function listWebsiteCapabilities(websiteId: number): Promise<CapabilityGrant[]> {
  const rows = await query<{ capability: string; enabled: boolean; updated_at: string }>(
    `SELECT capability, enabled, updated_at FROM website_capabilities
     WHERE website_id = $1 ORDER BY capability ASC`,
    [websiteId]
  );
  return rows.map((r) => ({ capability: r.capability, enabled: r.enabled, updatedAt: r.updated_at }));
}

export async function grantWebsiteCapability(
  websiteId: number,
  capability: string,
  enabled: boolean
): Promise<CapabilityGrant> {
  if (!isGrantableCapability(capability)) {
    throw new ConnectorError("INVALID_CAPABILITY", `capability must be one of ${CONNECTOR_CAPABILITIES.join(", ")}`);
  }
  const rows = await query<{ capability: string; enabled: boolean; updated_at: string }>(
    `INSERT INTO website_capabilities (website_id, capability, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (website_id, capability)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING capability, enabled, updated_at`,
    [websiteId, capability, enabled]
  );
  return { capability: rows[0].capability, enabled: rows[0].enabled, updatedAt: rows[0].updated_at };
}

/** Deterministic §394 check used by the webhook route (and future outbound ops). */
export async function websiteHasCapability(websiteId: number, capability: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM website_capabilities
     WHERE website_id = $1 AND capability = $2 AND enabled = true`,
    [websiteId, capability]
  );
  return rows[0].n > 0;
}

/* ------------------------------------------------------------------ */
/* delivery log + replay cache                                         */
/* ------------------------------------------------------------------ */

export interface RecordDeliveryResult {
  /** false = replay of an already-recorded delivery (or a suppressed duplicate). */
  recorded: boolean;
  /** true when a retryable row (failed/rejected) was re-recorded for retry. */
  reprocessed: boolean;
  deliveryRowId: number | null;
}

/**
 * Record an inbound delivery attempt.
 *
 *  - overwriteRetryable=false (rejection path): plain insert, conflicts are
 *    silently dropped — a rejected attempt can never overwrite a row that a
 *    validly signed delivery already claimed (and rejections must not be
 *    required to have unique ids).
 *  - overwriteRetryable=true (acceptance path): a row whose status is
 *    'failed' or 'rejected' may be re-recorded — sender retries with the
 *    same delivery id must be processed, not lost. A conflict with a row
 *    that was already 'received'/'accepted' returns recorded=false → replay.
 */
export async function recordDelivery(p: {
  websiteId: number;
  integrationId: number | null;
  deliveryId: string;
  eventType: string;
  signatureValid: boolean;
  status: "received" | "accepted" | "rejected" | "failed";
  rejectionReason?: string | null;
  payload?: Record<string, unknown> | null;
  taskId?: number | null;
  overwriteRetryable?: boolean;
}): Promise<RecordDeliveryResult> {
  const conflictAction = p.overwriteRetryable
    ? `DO UPDATE
         SET status = 'received', signature_valid = EXCLUDED.signature_valid,
             event_type = EXCLUDED.event_type, payload = EXCLUDED.payload,
             rejection_reason = NULL, task_id = NULL, created_at = now()
       WHERE connector_deliveries.status IN ('failed','rejected')`
    : "DO NOTHING";
  const rows = await query<{ id: string; inserted: boolean }>(
    `INSERT INTO connector_deliveries
       (website_id, integration_id, delivery_id, event_type, signature_valid, status, rejection_reason, payload, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (website_id, delivery_id) ${conflictAction}
     RETURNING id, (xmax = 0) AS inserted`,
    [
      p.websiteId,
      p.integrationId,
      p.deliveryId.slice(0, 200),
      p.eventType.slice(0, 100),
      p.signatureValid,
      p.status,
      p.rejectionReason ?? null,
      p.payload ? JSON.stringify(p.payload) : null,
      p.taskId ?? null,
    ]
  );
  if (rows.length === 0) return { recorded: false, reprocessed: false, deliveryRowId: null };
  return {
    recorded: true,
    reprocessed: !rows[0].inserted,
    deliveryRowId: Number(rows[0].id),
  };
}

export async function markDeliveryOutcome(
  deliveryRowId: number,
  outcome: { status: "accepted" | "rejected" | "failed"; rejectionReason?: string | null; taskId?: number | null }
): Promise<void> {
  await query(
    `UPDATE connector_deliveries
     SET status = $2, rejection_reason = $3, task_id = COALESCE($4, task_id)
     WHERE id = $1`,
    [deliveryRowId, outcome.status, outcome.rejectionReason ?? null, outcome.taskId ?? null]
  );
}

export async function recentDeliveries(
  integrationId: number,
  limit = 50
): Promise<DeliveryRow[]> {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await query<any>(
    `SELECT id, website_id, integration_id, delivery_id, event_type, signature_valid,
            status, rejection_reason, task_id, created_at
     FROM connector_deliveries
     WHERE integration_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT ${capped}`,
    [integrationId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    websiteId: Number(r.website_id),
    integrationId: r.integration_id != null ? Number(r.integration_id) : null,
    deliveryId: r.delivery_id,
    eventType: r.event_type,
    signatureValid: r.signature_valid,
    status: r.status,
    rejectionReason: r.rejection_reason ?? null,
    taskId: r.task_id != null ? Number(r.task_id) : null,
    createdAt: r.created_at,
  }));
}
