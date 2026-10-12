// One-shot schema migration used by the compose `migrate` service: applies services/indexer/migrations in order.
import pg from 'pg';
import { migrate } from '@opening-cross/indexer';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const db = new pg.Pool({ connectionString: url });
await migrate(db);
const { rows } = await db.query("SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'");
console.log(JSON.stringify({ at: new Date().toISOString(), migrated: true, publicTables: rows[0].tables }));
await db.end();
