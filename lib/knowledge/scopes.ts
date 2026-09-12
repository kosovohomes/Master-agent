/**
 * Scope enforcement (Phase 5 §9.1). Builds the WHERE fragment that makes the
 * five-scope model mechanically enforced on EVERY leg of retrieval:
 *
 *   GLOBAL       documents.business_unit_id IS NULL                    (visible to all)
 *   BUSINESS     documents.business_unit_id = caller BU                (BU partition)
 *   WEBSITE      documents.website_id IS NULL (= BU-wide) OR = caller site
 *                (a BU-wide caller sees website-scoped docs: it serves them)
 *   JURISDICTION documents.jurisdiction IS NULL (= unscoped) OR = caller's
 *                jurisdiction — law from X is never returned for Y (§50–§51)
 *   AGENT        documents.agent_scopes = '[]' (unrestricted) OR contains the
 *                caller's agent slug
 *
 * Additionally: authority ceiling (1 government/court … 5 unverified),
 * access_level='public' hard filter for anonymous callers, effective-date
 * as-of filter, language filter. The fragment is built with positional
 * parameters only — values never concatenate into SQL.
 */
import type { KnowledgeScope } from "./types";

export function scopeWhere(scope: KnowledgeScope, params: unknown[]): string {
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const conds: string[] = [];

  if (!scope.unrestricted) {
    const bu = scope.businessUnitId ?? null;
    if (bu != null) {
      conds.push(`(d.business_unit_id IS NULL OR d.business_unit_id = ${push(bu)})`);
    } else {
      // Global-only caller: sees global docs only — never another BU's corpus.
      conds.push(`d.business_unit_id IS NULL`);
    }
    const ws = scope.websiteId ?? null;
    if (ws != null) {
      conds.push(`(d.website_id IS NULL OR d.website_id = ${push(ws)})`);
    }
  }

  if (scope.agentSlug != null && scope.agentSlug !== "") {
    // jsonb ? checks array ELEMENT membership (and object keys) — exact fit
    // for agent_scopes: '["research","legal_intelligence"]'.
    conds.push(`(d.agent_scopes = '[]'::jsonb OR d.agent_scopes ? ${push(scope.agentSlug)})`);
  }

  if (scope.jurisdiction != null && scope.jurisdiction !== "") {
    conds.push(`(d.jurisdiction IS NULL OR d.jurisdiction = ${push(scope.jurisdiction)})`);
  }

  if (scope.language != null && scope.language !== "") {
    conds.push(`(d.language IS NULL OR d.language = ${push(scope.language)})`);
  }

  const tier = scope.maxAuthorityTier ?? 5;
  conds.push(`d.authority_tier <= ${push(tier)}`);

  if (scope.publicOnly) {
    conds.push(`d.access_level = 'public'`);
  }

  if (scope.asOfDate != null && scope.asOfDate !== "") {
    conds.push(`(d.effective_date IS NULL OR d.effective_date <= ${push(scope.asOfDate)}::date)`);
  }

  return conds.join(" AND ");
}
