// Each database test gets its own Postgres schema, so test files can run in parallel against
// one server without seeing each other's rows.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '@opening-cross/indexer';

export async function freshDb(): Promise<{ db: pg.Pool; client: () => Promise<pg.Client> }> {
  const url = process.env.DATABASE_URL!;
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const options = `-c search_path=${schema}`;
  const db = new pg.Pool({ connectionString: url, options });
  await migrate(db);
  return {
    db,
    client: async () => {
      const c = new pg.Client({ connectionString: url, options });
      await c.connect();
      return c;
    },
  };
}
