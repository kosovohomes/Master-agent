import Link from "next/link";
import { requireSessionUser } from "@/lib/auth/server";
import { query } from "@/lib/db";
import { listBusinessUnits, listWebsitesForBusinessUnits, permittedLegacyTenantIds } from "@/lib/bu";
import { buScopeForUser } from "@/lib/auth/rbac";
import { listDraftsByTenants } from "@/lib/agents/approval";

export const dynamic = "force-dynamic";

type QuickAction = { href: string; title: string; description: string };

function countLabel(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Friendly home screen. The goal is to answer three questions quickly:
 * what needs me, what can I do next, and how is the workspace doing.
 */
export default async function DashboardPage() {
  const user = await requireSessionUser();
  const perms = new Set(user.permissions);

  const canApprove = perms.has("drafts.read");
  const canUseAgents =
    perms.has("drafts.read") || perms.has("agents.manage") || perms.has("agents.run");
  const canUseWebsites =
    perms.has("bu.manage") || perms.has("website.manage") || perms.has("drafts.read");
  const canAudit = perms.has("audit.read");

  const scope = await buScopeForUser(user.id);
  const tenantScope = await permittedLegacyTenantIds(user.id);

  const allBus = await listBusinessUnits();
  const bus = scope.kind === "all" ? allBus : allBus.filter((b) => scope.businessUnitIds.includes(b.id));

  const websites =
    scope.kind === "all"
      ? (await query<{ n: number }>("SELECT count(*)::int AS n FROM websites"))[0].n
      : (await listWebsitesForBusinessUnits(scope.businessUnitIds)).length;

  const pendingDrafts = canApprove
    ? tenantScope.kind === "all"
      ? (await query<{ n: number }>("SELECT count(*)::int AS n FROM drafts WHERE status = 'pending'"))[0].n
      : (await listDraftsByTenants(tenantScope.tenantIds, "pending")).length
    : 0;

  const auditEvents = canAudit
    ? (await query<{ n: number }>("SELECT count(*)::int AS n FROM audit_logs WHERE created_at > now() - interval '24 hours'"))[0].n
    : 0;

  const firstName = (user.displayName ?? user.email).split(/[\s@]/)[0] || "there";

  const quickActions: QuickAction[] = [];
  if (canApprove) {
    quickActions.push({
      href: "/approvals",
      title: "Review approvals",
      description: "See what the agents prepared and approve or send it back.",
    });
  }
  if (canUseAgents) {
    quickActions.push({
      href: "/agents",
      title: "Work with agents",
      description: "Check your agents and start a new task.",
    });
  }
  if (canUseWebsites) {
    quickActions.push({
      href: "/websites",
      title: "Check websites",
      description: "See the websites connected to your work.",
    });
  }
  if (canAudit) {
    quickActions.push({
      href: "/operations",
      title: "View activity",
      description: "Follow what happened across your workspace.",
    });
  }
  if (quickActions.length === 0) {
    quickActions.push({
      href: "/settings",
      title: "Account settings",
      description: "Review your account details and preferences.",
    });
  }

  return (
    <div className="os-content">
      <header className="os-welcome">
        <div className="os-eyebrow">Home</div>
        <h1>Welcome back, {firstName}</h1>
        <p>Here is what needs your attention today.</p>
      </header>

      {canApprove && (
        <section
          className={`os-attention ${pendingDrafts > 0 ? "os-attention-waiting" : "os-attention-clear"}`}
          aria-label="Approval status"
        >
          <div>
            <h2>
              {pendingDrafts > 0
                ? `${countLabel(pendingDrafts, "item")} waiting for your approval`
                : "You are all caught up"}
            </h2>
            <p>
              {pendingDrafts > 0
                ? "Take a look when you are ready. Nothing is sent until you approve it."
                : "There is nothing waiting for your approval right now."}
            </p>
          </div>
          <Link href="/approvals" className="cc-btn cc-btn-primary">
            {pendingDrafts > 0 ? "Review now" : "Open approvals"}
          </Link>
        </section>
      )}

      <section aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title" className="os-section-title">Quick actions</h2>
        <div className="os-actions">
          {quickActions.map((action) => (
            <Link key={action.href} href={action.href} className="os-action-card">
              <div className="os-action-title">{action.title}</div>
              <div className="os-action-desc">{action.description}</div>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="workspace-title" className="mt-8">
        <h2 id="workspace-title" className="os-section-title">Your workspace</h2>
        <div className="os-metrics">
          <div className="os-metric">
            <span className="os-metric-value">{websites}</span>
            <span className="os-metric-label">Websites</span>
          </div>
          <div className="os-metric">
            <span className="os-metric-value">{bus.length}</span>
            <span className="os-metric-label">Businesses</span>
          </div>
          {canAudit && (
            <div className="os-metric">
              <span className="os-metric-value">{auditEvents}</span>
              <span className="os-metric-label">Activity in the last day</span>
            </div>
          )}
        </div>

        <div className="cc-card">
          <h3 className="os-card-title">Your businesses</h3>
          {bus.length === 0 ? (
            <p className="os-empty">No businesses are visible to you yet.</p>
          ) : (
            <ul className="os-business-list">
              {bus.map((b) => (
                <li key={b.id}>
                  <div>
                    <div className="os-business-name">{b.name}</div>
                    <div className="os-business-meta">{countLabel(b.websiteCount, "website")}</div>
                  </div>
                  <span className={`cc-badge ${b.status === "active" ? "cc-badge-ok" : "cc-badge-warn"}`}>
                    {b.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="os-help">
        Looking for something more advanced? Open <strong>More tools</strong> in the left menu.
      </p>
    </div>
  );
}
