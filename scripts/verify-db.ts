import { query } from "../lib/db";

const checks: Array<[string, string, (rows: any[]) => boolean]> = [
  ["pgvector extension", "SELECT extname FROM pg_extension WHERE extname = 'vector'", (r) => r.length === 1],
  ["migration ledger count", "SELECT count(*)::int AS n FROM schema_migrations", (r) => r[0]?.n === 54],
  ["core tables present", "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','drafts','chunks','documents','tasks','sessions','content_publications')", (r) => r[0]?.n === 7],
  ["roles seeded", "SELECT count(*)::int AS n FROM roles", (r) => Number(r[0]?.n) > 0],
];

let bad = 0;
for (const [name, sql, ok] of checks) {
  const rows = await query(sql);
  const pass = ok(rows);
  if (!pass) bad++;
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(rows).slice(0, 200)}`);
}
process.exit(bad === 0 ? 0 : 1);
