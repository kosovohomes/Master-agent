import assert from "node:assert";
import { query, transaction } from "../lib/db";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const tables: string[] = [];
for (const row of await query<{ tablename: string }>(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('tenants','tenant_config','channels','content_sources','documents','chunks','agent_runs','drafts','approvals','leads','outbox')"
)) tables.push(row.tablename);

check("all 11 agentos tables exist", tables.length === 11, tables.join(","));
check("pgvector extension present", (await query<{ installed: boolean }>(
  "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed"
))[0].installed === true);

// schema is idempotent: running DDL again must not error — verified in Step 3 via migrate re-run.
check("vector column type on chunks", (await query<{ ok: boolean }>(
  "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chunks' AND column_name='embedding' AND udt_name='vector') AS ok"
))[0].ok === true);

// --- real DB behavior (written here so the schema contract is exercised, not just introspected) ---
const slug = `tdd-${Date.now()}`;
let tid: string | undefined;
try {
  const ins = await query<{ id: string }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [slug, "TDD Realness"]
  );
  tid = ins[0].id;
  check("tenant insert returns id", typeof tid === "string" && tid.length > 0, `got ${typeof tid}`);
  check(
    "tenant row persists after insert",
    (await query<{ id: string }>("SELECT id FROM tenants WHERE id = $1", [tid])).length === 1
  );

  try {
    await query("INSERT INTO tenants (slug, name) VALUES ($1, $2)", [slug, "dup"]);
    check("duplicate tenant slug rejected (unique)", false, "no error raised");
  } catch (e) {
    check("duplicate tenant slug rejected (unique)", (e as Error).message.includes("unique"),
      (e as Error).message.slice(0, 80));
  }

  check(
    "pgvector cosine-distance CAST works",
    typeof (await query<{ d: number }>(`SELECT '[1,2,3]'::vector <=> '[4,5,6]'::vector AS d`))[0].d === "number"
  );
} finally {
  if (tid !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tid]);
}

// --- transaction() helper: commit path + rollback-on-throw ---
const txSlugs = [`tdd-tx-commit-${Date.now()}`, `tdd-tx-rollback-${Date.now()}`];
try {
  const txId = await transaction(async (tq) => {
    const r = await tq<{ id: string }>(
      "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
      [txSlugs[0], "Tx Commit"]
    );
    return r[0].id;
  });
  check("transaction commits",
    (await query<{ id: string }>("SELECT id FROM tenants WHERE id = $1", [txId])).length === 1);

  let sawRollbackError = false;
  try {
    await transaction(async (tq) => {
      await tq("INSERT INTO tenants (slug, name) VALUES ($1, $2)", [txSlugs[1], "Tx Rollback"]);
      throw new Error("boom");
    });
  } catch (e) {
    sawRollbackError = (e as Error).message === "boom";
  }
  check("transaction rolls back on throw", sawRollbackError);
  check("rolled-back row absent",
    (await query("SELECT id FROM tenants WHERE slug = $1", [txSlugs[1]])).length === 0);
} finally {
  await query("DELETE FROM tenants WHERE slug = ANY($1)", [txSlugs]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("DB SUITE PASS");