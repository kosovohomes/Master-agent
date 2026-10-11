/**
 * Website connector contract (Phase 6 — Phase 0.5 §12, §394, §411).
 *
 * A connector is a `website_integrations` row that binds an external site to
 * the platform through a signed inbound webhook. What a connector may DO is
 * bounded by capability grants on its website (`website_capabilities`, migration
 * 008) — the §394 canonical catalog is enumerated here and enforced
 * server-side: an event (or, in later phases, an agent invoking a connector
 * operation) is only processed when (a) the website granted the capability and
 * (b) the caller is authenticated (for inbound events: a valid HMAC signature;
 * for agent-invoked operations: the matching agent permission — wired in the
 * workforce phases that actually emit those operations).
 */

/** §394 canonical capability catalog (grants live on website_capabilities). */
export const CONNECTOR_CAPABILITIES = [
  "READ_CONTENT",
  "CREATE_CONTENT",
  "UPDATE_CONTENT",
  "PUBLISH_CONTENT",
  "READ_LEADS",
  "CREATE_LEAD",
  "READ_ANALYTICS",
  "SEND_NOTIFICATION",
  "READ_PRODUCTS",
  "chat.answer",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

/**
 * `chat.answer` (P13) — the widget/chat pair is now a fully grantable
 * capability (§13 connector #1, §411 completion): the public chat/inquiry
 * routes REQUIRE it when a site key is presented, and migration 050 seeds
 * the grant for widget integrations that predate enforcement.
 *
 * RESERVED_CAPABILITIES remains exported (empty) so Phase 6 imports keep
 * compiling; new capabilities may be reserved here again in later phases.
 */
export const RESERVED_CAPABILITIES = [] as const;

export function isGrantableCapability(value: string): value is ConnectorCapability {
  return (CONNECTOR_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Connector types (integration_type on website_integrations).
 * P13 adds "widget": the site-registered embed connector (§13 connector #1)
 * whose credential is a generated site key stored in config.siteKey —
 * presented by the embed and resolved by resolveSiteKey (lib/sales/service).
 */
export const CONNECTOR_TYPES = ["webhook", "widget"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

/**
 * Inbound event types → capability required to act on them (§394: gated
 * server-side, deterministic). Events absent from this map are accepted and
 * logged but never acted on (forward compatibility — one site sending an
 * event the platform does not understand yet must not fail the endpoint).
 */
export const EVENT_CAPABILITIES: Record<string, ConnectorCapability> = {
  "content.sync": "READ_CONTENT",
  "content.updated": "READ_CONTENT",
  "sitemap.updated": "READ_CONTENT",
  "lead.created": "CREATE_LEAD",
  "analytics.ping": "READ_ANALYTICS",
};

/** Events the Phase 6 event router executes (vs record-only). */
export const SYNC_EVENT_TYPES = ["content.sync", "content.updated", "sitemap.updated"] as const;

export interface ConnectorWebsite {
  id: number;
  businessUnitId: number;
  slug: string;
  name: string;
  domain: string | null;
  status: string;
}

export interface ConnectorRow {
  id: number;
  websiteId: number;
  businessUnitId: number;
  websiteName: string;
  websiteSlug: string;
  type: string;
  displayName: string | null;
  status: "active" | "disabled" | "error";
  signingAlgo: string;
  capabilities: ConnectorCapability[];
  lastEventAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
  deliveries24h: number;
  failed24h: number;
}

export interface DeliveryRow {
  id: number;
  websiteId: number;
  integrationId: number | null;
  deliveryId: string;
  eventType: string;
  signatureValid: boolean;
  status: "received" | "accepted" | "rejected" | "failed";
  rejectionReason: string | null;
  taskId: number | null;
  createdAt: string;
}

/** Parsed `X-AgentOS-Signature: t=<unix_seconds>,v1=<hex>` header. */
export interface SignatureHeader {
  timestamp: number;
  signature: string;
}

export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: "malformed_header" | "stale_timestamp" | "invalid_signature" };

/** Envelope accepted by POST /api/integrations/:siteId/events. */
export interface ConnectorEventPayload {
  type: string;
  data?: Record<string, unknown>;
  sentAt?: string;
}
