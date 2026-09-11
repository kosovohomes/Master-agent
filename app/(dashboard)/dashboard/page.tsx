import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/server";
import { query } from "@/lib/db";
import { listBusinessUnits, listWebsitesForBusinessUnits } from "@/lib/bu";
import { buScopeForUser } from "@/lib/auth/rbac";
import { permittedLegacyTenantIds } from "@/lib/bu";
import { listDraftsByTenants } from "@/lib/agents/approval";

export const dynamic = "force-dynamic";

/**
 * Command Center home (Phase 1 M3 foundation). Counts respect the caller's
 * BU scope; audit visibility follows audit.read. This is a foundation
 * surface — workforce dashboards arrive with their own phases.
 */
export default async function DashboardPage() {
  const user = await requireSessionUser();
  const scope = await buScopeForUser(user.id);
  const tenantScope = await permittedLegacyTenantIds(user.id);

  const allBus = await listBusinessUnits();
  const bus = scope.kind === "all" ? allBus : allBus.filter((b) => scope.businessUnitIds.includes(b.id));

  const websites =
    scope.kind === "all"
      ? (await query<{ n: number }>("SELECT count(*)::int AS n FROM websites"))[0].n
      : (await listWebsitesForBusinessUnits(scope.businessUnitIds)).length;

  const pendingDrafts =
    tenantScope.kind === "all"
      ? (await query<{ n: number }>("SELECT count(*)::int AS n FROM drafts WHERE status = 'pending'"))[0].n
      : (await listDraftsByTenants(tenantScope.tenantIds, "pending")).length;

  const canAudit = user.permissions.includes("audit.read");
  const auditEvents = canAudit
    ? (await query<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE created_at > now() - interval '24 hours'"))[0].n
    : null;

  const stats = [
    { label: "Business units", value: String(bus.length), href: "/websites" },
    { label: "Websites", value: String(websites), href: "/websites" },
    { label: "Pending approvals", value: String(pendingDrafts), href: "/approvals" },
    ...(canAudit ? [{ label: "Audit events (24h)", value: String(auditEvents), href: "/audit" }] : []),
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Platform foundation — identity, businesses, websites, and oversight.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="cc-card hover:border-[var(--accent)] transition-colors">
            <div className="text-3xl font-semibold">{s.value}</div>
            <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>{s.label}</div>
          </Link>
        ))}
      </section>

      <section className="cc-card">
        <h2 className="text-sm font-semibold mb-3">Business units</h2>
        {bus.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            No business units visible to you yet.
          </p>
        ) : (
          <table className="cc-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Status</th>
                <th>Websites</th>
                <th>Legacy tenant</th>
              </tr>
            </thead>
            <tbody>
              {bus.map((b) => (
                <tr key={b.id}>
                  <td className="font-medium">{b.name}</td>
                  <td>{b.slug}</td>
                  <td>
                    <span className={`cc-badge ${b.status === "active" ? "cc-badge-ok" : "cc-badge-warn"}`}>{b.status}</span>
                  </td>
                  <td>{b.websiteCount}</td>
                  <td>{b.legacyTenantId ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="cc-card text-sm" style={{ color: "var(--muted)" }}>
        <p>
          <strong style={{ color: "var(--foreground)" }}>Scope note:</strong> agent registry, workflows,
          the AI gateway, and connectors are later phases per the approved roadmap — they are
          intentionally absent here.
        </p>
      </section>
    </div>
  );
}
