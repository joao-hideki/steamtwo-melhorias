import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runner } from "node-pg-migrate";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

import "dotenv/config";

/**
 * Os testes de integração usam um banco separado (`<banco>_test`) para nunca apagar
 * os dados de desenvolvimento. Ordem: TEST_DATABASE_URL → DATABASE_URL com sufixo
 * `_test` (lido do .env). Sem nenhum dos dois, a suíte é pulada com aviso.
 */
function resolveTestDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!process.env.DATABASE_URL) return "";
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `${url.pathname.replace(/_test$/, "")}_test`;
  return url.toString();
}

export const testDatabaseUrl = resolveTestDatabaseUrl();
if (!testDatabaseUrl) {
  console.warn("[tests/db] PULADO: defina DATABASE_URL (.env) ou TEST_DATABASE_URL para rodar a integração com PostgreSQL.");
}

async function ensureDatabaseExists(url) {
  const target = new URL(url);
  const databaseName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (!exists.rows.length) await client.query(`CREATE DATABASE "${databaseName.replace(/"/g, "")}"`);
  } finally {
    await client.end();
  }
}

/** Recria o schema do zero e aplica todas as migrações reais do projeto. */
export async function resetDatabase() {
  await ensureDatabaseExists(testDatabaseUrl);
  const client = new pg.Client({ connectionString: testDatabaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
  await runner({
    databaseUrl: testDatabaseUrl,
    dir: path.join(rootDir, "migrations"),
    direction: "up",
    migrationsTable: "pgmigrations",
    log: () => {},
  });
}
