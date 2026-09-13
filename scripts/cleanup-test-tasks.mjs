import pg from "pg";
import fs from "node:fs";
const env = fs.readFileSync(".env.local", "utf8");
const url = env.split("\n").find((l) => l.startsWith("DATABASE_URL=")).slice("DATABASE_URL=".length).trim();
const pool = new pg.Pool({ connectionString: url });
const r = await pool.query(
  `UPDATE tasks SET status='cancelled', error='cleanup: stale local test artifact', finished_at=now(), updated_at=now()
   WHERE created_by='test' AND status IN ('queued','claimed','running') RETURNING id`
);
console.log("cancelled stale test tasks:", r.rowCount);
await pool.end();
