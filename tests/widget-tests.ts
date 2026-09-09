import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getWidgetConfig } from "../lib/widget";
import { GET } from "../app/api/v1/widget/config/route";
import { query } from "../lib/db";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdTenantIds: number[] = [];

try {
  // ---------- config resolution: slug + numeric id ----------
  const [t] = await query<{ id: number; slug: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug`,
    [`t-widget-${stamp}`, "Widget Co"]
  );
  createdTenantIds.push(t.id);
  await query(
    "INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)",
    [t.id, "friendly", "helper", "small biz"]
  );

  const cfg = await getWidgetConfig(t.slug);
  check("slug lookup resolves", cfg.tenantId === t.id && cfg.brand === "Widget Co", JSON.stringify(cfg));
  check("config is brand-safe (no tokens/keys)", !JSON.stringify(cfg).includes("secret") && !JSON.stringify(cfg).includes("Bearer"));

  const cfgNumeric = await getWidgetConfig(String(t.id));
  check("numeric id lookup resolves", cfgNumeric.tenantId === t.id && cfgNumeric.brand === "Widget Co", JSON.stringify(cfgNumeric));

  // ---------- route: valid tenant (slug + numeric), public shape only ----------
  const okRes = await GET(new Request(`http://localhost/api/v1/widget/config?tenant=${t.slug}`));
  const okBody = (await okRes.json()) as { data?: { tenantId: number; brand: string }; meta?: { ts: string } };
  check("route: valid tenant returns 200 + public config", okRes.status === 200 && okBody.data?.tenantId === t.id && okBody.data?.brand === "Widget Co", JSON.stringify(okBody));
  check("route: response carries meta.ts", typeof okBody.meta?.ts === "string");
  check("route: numeric data-tenant resolves", (await GET(new Request(`http://localhost/api/v1/widget/config?tenant=${t.id}`))).status === 200);

  const rawOk = JSON.stringify(okBody);
  check("route: config is brand-safe (no tokens/keys)", !rawOk.includes("secret") && !rawOk.includes("Bearer") && !rawOk.includes("token"));
  check("route: config body exposes only tenantId + brand", Object.keys(okBody.data ?? {}).sort().join(",") === "brand,tenantId");

  // ---------- privacy: no cross-tenant leakage, suspended tenant hidden ----------
  const [other] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [`t-widget-other-${stamp}`, "Other Corp"]
  );
  createdTenantIds.push(other.id);
  const otherBody = (await (await GET(new Request(`http://localhost/api/v1/widget/config?tenant=${other.id}`))).json()) as { data?: { brand: string } };
  check("route: tenant B never sees tenant A's brand", otherBody.data?.brand === "Other Corp" && !rawOk.includes("Other Corp"), JSON.stringify(otherBody));

  const [susp] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name, status) VALUES ($1, $2, 'suspended') RETURNING id`,
    [`t-widget-susp-${stamp}`, "Suspended Co"]
  );
  createdTenantIds.push(susp.id);
  const suspRes = await GET(new Request(`http://localhost/api/v1/widget/config?tenant=${susp.id}`));
  check("route: suspended tenant is not resolvable (4xx)", suspRes.status >= 400 && suspRes.status < 500, `status=${suspRes.status}`);

  // ---------- route: missing / unknown / malformed ----------
  const missingRes = await GET(new Request("http://localhost/api/v1/widget/config"));
  const missingBody = (await missingRes.json()) as { errors: { code: string }[] };
  check("route: missing tenant param -> 400 MISSING_TENANT", missingRes.status === 400 && missingBody.errors?.[0]?.code === "MISSING_TENANT", JSON.stringify(missingBody));

  const unknownRes = await GET(new Request("http://localhost/api/v1/widget/config?tenant=no-such-tenant-xyz"));
  const unknownBody = (await unknownRes.json()) as { errors: { code: string }[] };
  check("route: unknown tenant -> 404 UNKNOWN_TENANT", unknownRes.status === 404 && unknownBody.errors?.[0]?.code === "UNKNOWN_TENANT", JSON.stringify(unknownBody));

  const weirdRes = await GET(new Request(`http://localhost/api/v1/widget/config?tenant=${encodeURIComponent("inject' OR 1=1 --")}`));
  check("route: malformed/injection tenant id -> 4xx", weirdRes.status >= 400 && weirdRes.status < 500, `status=${weirdRes.status}`);

  // ---------- widget script: evaluated as text, never executed ----------
  const widgetPath = "public/widget.js";
  const src = existsSync(widgetPath) ? await readFile(widgetPath, "utf8") : "";
  check("widget is served from public/ (Next static asset, application/javascript)", existsSync(widgetPath) && src.length > 0);

  check("widget reads numeric data-tenant", src.includes('getAttribute("data-tenant")'));
  check("widget POSTs tenantId: Number(tenant) to /api/v1/chat", src.includes("tenantId: Number(tenant)") && src.includes('"/api/v1/chat"'));
  check("widget renders answer from j.data.answer", src.includes("j.data.answer"));
  check("widget renders sources from j.data.sources", src.includes("j.data.sources[0].title") && src.includes(".aos-src"));
  check("widget is CSP-safe (no eval/new Function/inline handlers)", !/\beval\s*\(|new\s+Function|onclick\s*=|onload\s*=|onerror\s*=|javascript:/i.test(src));
  check("widget contains no <script injection string", !src.includes("<script"));
  check("widget is self-contained (no imports, no external URLs)", !src.includes("import ") && !src.includes("https://") && !src.includes("http://"));
} finally {
  if (createdTenantIds.length > 0) {
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds]);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("WIDGET SUITE PASS");