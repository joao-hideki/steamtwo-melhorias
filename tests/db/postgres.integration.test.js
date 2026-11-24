import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../server/app.js";
import { createCatalogReadRepository } from "../../server/db/catalog-read-repository.js";
import { createJobRepository } from "../../server/db/job-repository.js";
import { createPool } from "../../server/db/pool.js";
import { seedCatalog } from "../../server/db/seed.js";
import { syncRankings, syncScores } from "../../server/jobs/index.js";
import { runLockedSync } from "../../server/jobs/run-job.js";
import { createApiRouter } from "../../server/routes/index.js";
import { createCatalogService } from "../../server/services/catalog-service.js";
import { resetDatabase, testDatabaseUrl } from "./helpers.js";

const LIST_ID = "6f1c1d3e-8a2b-4c5d-9e0f-112233445566";
const capturedAt = new Date("2026-11-20T12:00:00.000Z");

/**
 * Integração real API ⇄ PostgreSQL: migrações, seed, coleta (com clientes
 * Steam/Epic simulados), cálculo do índice e leitura pela API HTTP.
 * Rode com TEST_DATABASE_URL (ver README); sem a variável, a suíte é pulada.
 */
describe.skipIf(!testDatabaseUrl)("PostgreSQL — integração completa", () => {
  let pool;
  let jobs;
  let app;

  beforeAll(async () => {
    await resetDatabase();
    pool = createPool(testDatabaseUrl);
    jobs = await createJobRepository({ databaseUrl: testDatabaseUrl });
    app = createApp({
      apiRouter: createApiRouter({
        catalogService: createCatalogService({ repository: createCatalogReadRepository(pool) }),
        healthCheck: async () => (await pool.query("SELECT 1"), { status: "connected" }),
      }),
    });
  }, 60_000);

  afterAll(async () => {
    await jobs?.close();
    await pool?.end();
  });

  it("aplica as migrações e cria as tabelas do domínio", async () => {
    const result = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const tables = result.rows.map((row) => row.table_name);
    for (const table of ["games", "genres", "store_listings", "ranking_snapshots", "ranking_entries", "game_rankings", "sync_runs", "watchlist_items"]) {
      expect(tables).toContain(table);
    }
  });

  it("seed é idempotente (rodar duas vezes não duplica jogos)", async () => {
    await jobs.upsertCatalogGames(seedCatalog(), { source: "seed" });
    await jobs.upsertCatalogGames(seedCatalog(), { source: "seed" });
    const { rows } = await pool.query("SELECT count(*)::int AS total FROM games");
    expect(rows[0].total).toBe(10);
  });

  it("coleta grava snapshots, vincula a Epic pelo título e registra o sync_run com sucesso", async () => {
    const result = await syncRankings({
      repository: jobs,
      now: () => capturedAt,
      steam: {
        getMostPlayedGames: async () => [
          { externalId: "730", rank: 1, metric: 1_000_000 },
          { externalId: "1245620", rank: 2, metric: 70_000 },
          { externalId: "999999", rank: 3, metric: 10 }, // app fora do catálogo: ignorado
        ],
        getGamesByConcurrentPlayers: async () => [{ externalId: "1091500", rank: 4, metric: 30_000 }],
      },
      epic: {
        getMostPlayedGames: async () => [
          { externalId: "fortnite-id", title: "Fortnite", rank: 1 },
          { externalId: "cp2077-id", title: "Cyberpunk 2077", rank: 2 },
        ],
      },
    });
    expect(result.status).toBe("success");
    expect(result.sources.steam).toMatchObject({ status: "success", linked: 3 });
    expect(result.sources.epic).toMatchObject({ status: "success", linked: 1 });

    const listing = await pool.query(`SELECT g.slug FROM store_listings sl JOIN games g ON g.id = sl.game_id
      WHERE sl.store = 'epic' AND sl.external_id = 'cp2077-id'`);
    expect(listing.rows[0].slug).toBe("cyberpunk-2077");

    // Regressão: antes `jsonb_build_object('records', $4)` sem tipo fazia todo job terminar como falha.
    const run = await pool.query(`SELECT state, details FROM sync_runs WHERE job = 'rankings' ORDER BY started_at DESC LIMIT 1`);
    expect(run.rows[0]).toMatchObject({ state: "success", details: { records: 6 } });
  });

  it("snapshots são imutáveis (trigger do banco)", async () => {
    await expect(pool.query("UPDATE ranking_snapshots SET total_entries = 0")).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM ranking_entries")).rejects.toThrow(/immutable/);
  });

  it("calcula o Índice SteamTwo a partir dos snapshots (agora, semana e de sempre)", async () => {
    const result = await syncScores({ repository: jobs, now: () => new Date(capturedAt.getTime() + 60_000) });
    expect(result.status).toBe("success");
    const { rows } = await pool.query(`SELECT g.slug, r.rank, r.score::float AS score FROM game_rankings r
      JOIN games g ON g.id = r.game_id WHERE r.period = 'now' AND r.store = 'all' ORDER BY r.rank`);
    // CS2: 1º de 4 na Steam (100) e ausente numa Epic válida (0) → média 50.
    expect(rows[0]).toMatchObject({ slug: "counter-strike-2", rank: 1, score: 50 });
    // Cyberpunk: 4º de 4 na Steam (25) e 2º de 2 na Epic (50) → 37,5.
    expect(rows.find((row) => row.slug === "cyberpunk-2077").score).toBeCloseTo(37.5);
    const allTime = await pool.query("SELECT count(*)::int AS total FROM game_rankings WHERE period = 'all-time'");
    expect(allTime.rows[0].total).toBe(10);
  });

  it("advisory lock real impede dois jobs iguais ao mesmo tempo", async () => {
    const other = await createJobRepository({ databaseUrl: testDatabaseUrl });
    let release;
    const holding = runLockedSync({
      repository: jobs, job: "lock-test", lockKey: "steamtwo:test-lock",
      execute: () => new Promise((resolve) => { release = () => resolve({ records: 0 }); }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await runLockedSync({ repository: other, job: "lock-test", lockKey: "steamtwo:test-lock", execute: async () => ({ records: 0 }) });
    expect(second).toMatchObject({ status: "skipped", reason: "lock_not_acquired" });
    release();
    await expect(holding).resolves.toMatchObject({ status: "success" });
    await other.close();
  });

  it("API lê dashboard, rankings e catálogo do banco", async () => {
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.database.status).toBe("connected");

    const dashboard = await request(app).get("/api/dashboard").expect(200);
    expect(dashboard.body).toMatchObject({ mode: "database", isFallback: false });
    expect(dashboard.body.hero.slug).toBe("counter-strike-2");
    expect(dashboard.body.hero.metric).toMatchObject({ type: "players", value: 1_000_000 });

    const epicRanking = await request(app).get("/api/rankings").query({ period: "now", store: "epic" }).expect(200);
    expect(epicRanking.body.items.map((item) => item.slug)).toEqual(["cyberpunk-2077"]);

    const allTimeEpic = await request(app).get("/api/rankings").query({ period: "all-time", store: "epic" }).expect(200);
    expect(allTimeEpic.body.items.map((item) => item.rank)).toEqual([1]);

    const search = await request(app).get("/api/games").query({ q: "cyber" }).expect(200);
    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].stores.map((store) => store.store).sort()).toEqual(["epic", "steam"]);

    const page2 = await request(app).get("/api/games").query({ limit: 4, page: 3, sort: "name" }).expect(200);
    expect(page2.body.pagination).toMatchObject({ total: 10, pages: 3 });
    expect(page2.body.items).toHaveLength(2);

    const genres = await request(app).get("/api/genres").expect(200);
    expect(genres.body.items.find((genre) => genre.name === "RPG").games).toBeGreaterThan(1);

    const status = await request(app).get("/api/status").expect(200);
    expect(status.body.counts.games).toBe(10);
    expect(status.body.sources.details.steam.status).toBe("success");
  });

  it("busca trata % e _ como texto (sem curinga) e o SQL é parametrizado", async () => {
    const response = await request(app).get("/api/games").query({ q: "%' OR 1=1 --" }).expect(200);
    expect(response.body.items).toHaveLength(0);
  });

  it("lista pessoal persiste no PostgreSQL (adicionar, listar, remover)", async () => {
    await request(app).put("/api/list/elden-ring").set("X-List-Id", LIST_ID).expect(201);
    await request(app).put("/api/list/elden-ring").set("X-List-Id", LIST_ID).expect(201); // idempotente
    await request(app).put("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(201);
    const list = await request(app).get("/api/list").set("X-List-Id", LIST_ID).expect(200);
    expect(list.body.items.map((item) => item.slug)).toEqual(["portal-2", "elden-ring"]);

    const { rows } = await pool.query("SELECT count(*)::int AS total FROM watchlist_items WHERE list_id = $1", [LIST_ID]);
    expect(rows[0].total).toBe(2);

    await request(app).delete("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(200);
    await request(app).delete("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(404);
    await request(app).put("/api/list/jogo-que-nao-existe").set("X-List-Id", LIST_ID).expect(404);
    await request(app).get("/api/list").set("X-List-Id", "nao-e-uuid").expect(400);
  });
});
