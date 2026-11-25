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

  it("seed não sobrescreve dado que veio de outra fonte (ex.: popularidade da IGDB)", async () => {
    await jobs.upsertCatalogGames([{ externalId: "1", slug: "portal-2", title: "Portal 2", popularity: 12.5, genres: [{ name: "Quebra-cabeça" }] }], { source: "igdb" });
    await jobs.upsertCatalogGames(seedCatalog(), { source: "seed" });
    const game = await pool.query(`SELECT igdb_popularity::float AS pop,
      (SELECT array_agg(ge.name) FROM game_genres gg JOIN genres ge ON ge.id = gg.genre_id WHERE gg.game_id = g.id) AS genres
      FROM games g WHERE slug = 'portal-2'`);
    expect(game.rows[0]).toEqual({ pop: 12.5, genres: ["Quebra-cabeça"] });
    // Restaura: os testes seguintes validam o "De sempre" sem IGDB (pico monitorado).
    await pool.query("UPDATE games SET igdb_id = NULL, igdb_popularity = NULL WHERE slug = 'portal-2'");
  });

  it("seed não grava popularidade fictícia do catálogo de exemplo", async () => {
    const { rows } = await pool.query("SELECT count(*)::int AS total FROM games WHERE igdb_popularity IS NOT NULL");
    expect(rows[0].total).toBe(0);
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
    // CS2: 1º de 4 na Steam (100); não é vendido na Epic (sem vínculo) → a Epic não entra na média.
    expect(rows[0]).toMatchObject({ slug: "counter-strike-2", rank: 1, score: 100 });
    // Elden Ring: 2º de 4 na Steam → 75.
    expect(rows.find((row) => row.slug === "elden-ring").score).toBeCloseTo(75);
    // Cyberpunk: vendido nas duas; 4º de 4 na Steam (25) e 2º de 2 na Epic (50) → 37,5.
    expect(rows.find((row) => row.slug === "cyberpunk-2077").score).toBeCloseTo(37.5);
    // Sem IGDB, "De sempre" = maior índice que cada jogo já atingiu nas coletas (dado real).
    const allTime = await pool.query(`SELECT g.slug, r.score::float AS score, r.source FROM game_rankings r
      JOIN games g ON g.id = r.game_id WHERE r.period = 'all-time' ORDER BY r.rank`);
    expect(allTime.rows.map((row) => row.slug)).toEqual(["counter-strike-2", "elden-ring", "cyberpunk-2077"]);
    expect(allTime.rows[0]).toMatchObject({ score: 100, source: "steamtwo-peak" });
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
    // Sem o escape, "%" e "_" casariam com todos os 10 jogos.
    for (const q of ["%", "_", "%%"]) {
      const response = await request(app).get("/api/games").query({ q }).expect(200);
      expect(response.body.pagination.total).toBe(0);
    }
    const injection = await request(app).get("/api/games").query({ q: "%' OR 1=1 --", genre: "a';--" }).expect(200);
    expect(injection.body.items).toHaveLength(0);
  });

  it("lista pessoal persiste no PostgreSQL (adicionar, listar, remover)", async () => {
    const first = await request(app).put("/api/list/elden-ring").set("X-List-Id", LIST_ID).expect(201);
    expect(first.body).toEqual({ added: true });
    // Idempotente e com o mesmo contrato do modo demonstração: já estava → 200 {added:false}.
    const again = await request(app).put("/api/list/elden-ring").set("X-List-Id", LIST_ID).expect(200);
    expect(again.body).toEqual({ added: false });
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

  it("PUTs simultâneos na mesma lista nunca geram falso 'lista cheia' nem estouram o limite", async () => {
    const raceList = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    // 10 rodadas de 8 requisições iguais em paralelo: exatamente um 201 por rodada, o resto 200.
    for (let round = 0; round < 10; round += 1) {
      await pool.query("DELETE FROM watchlist_items WHERE list_id = $1", [raceList]);
      const statuses = await Promise.all(Array.from({ length: 8 }, () =>
        request(app).put("/api/list/elden-ring").set("X-List-Id", raceList).then((res) => res.status)));
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(7);
    }
    // Jogos diferentes em paralelo com limite 3: exatamente 3 entram.
    await pool.query("DELETE FROM watchlist_items WHERE list_id = $1", [raceList]);
    const repository = createCatalogReadRepository(pool);
    const slugs = (await pool.query("SELECT slug FROM games ORDER BY slug LIMIT 8")).rows.map((row) => row.slug);
    const outcomes = await Promise.all(slugs.map((slug) => repository.watchlist.add(raceList, slug, 3)));
    expect(outcomes.filter((o) => o === "added")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "full")).toHaveLength(5);
    const { rows } = await pool.query("SELECT count(*)::int AS total FROM watchlist_items WHERE list_id = $1", [raceList]);
    expect(rows[0].total).toBe(3);
  });

  it("byte nulo na busca é rejeitado com 400 (não chega ao banco)", async () => {
    await request(app).get("/api/games").query({ q: "a\u0000b" }).expect(400);
    await request(app).get("/api/games").query({ genre: "\u0000" }).expect(400);
  });

  it("lista cheia responde 409, mas re-adicionar um item que já está nela não é erro", async () => {
    const fullList = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await pool.query(`INSERT INTO watchlist_items (list_id, game_id)
      SELECT $1, id FROM games ORDER BY slug LIMIT 9`, [fullList]);
    const repository = createCatalogReadRepository(pool);
    const inList = (await pool.query(`SELECT g.slug FROM watchlist_items w JOIN games g ON g.id = w.game_id WHERE list_id = $1 LIMIT 1`, [fullList])).rows[0].slug;
    const missing = (await pool.query(`SELECT slug FROM games WHERE id NOT IN (SELECT game_id FROM watchlist_items WHERE list_id = $1) LIMIT 1`, [fullList])).rows[0].slug;
    expect(await repository.watchlist.add(fullList, inList, 9)).toBe("exists");
    expect(await repository.watchlist.add(fullList, missing, 9)).toBe("full");
    expect(await repository.watchlist.add(fullList, "nao-existe", 9)).toBe("not-found");
  });

  // Fica por último: muda o "agora" calculado.
  it("loja sem snapshot válido nas últimas 24 h sai do cálculo do 'agora'", async () => {
    const later = new Date(capturedAt.getTime() + 25 * 3_600_000);
    const result = await syncScores({ repository: jobs, now: () => later });
    expect(result.counts.all.now).toBe(0);
    const ranking = await request(app).get("/api/rankings").query({ period: "now" }).expect(200);
    expect(ranking.body.items).toEqual([]);
  });
});
