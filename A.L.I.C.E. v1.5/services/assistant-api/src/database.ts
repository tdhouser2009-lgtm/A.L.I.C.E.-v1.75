import pg from "pg";

const { Pool } = pg;
type PoolClient = pg.PoolClient;
export type { PoolClient };

export interface Queryable {
  query<T = any>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class Database implements Queryable {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 4_000,
      query_timeout: 5_000,
    });
  }

  query<T = any>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number | null }> {
    return this.pool.query(sql, values) as unknown as Promise<{ rows: T[]; rowCount: number | null }>;
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
