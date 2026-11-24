import { createPool, withTransaction } from "./pool.js";
import { createRepositories } from "./repositories.js";

function genreSlug(name) {
  return String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function storeUrl(store, externalId, suppliedUrl, title) {
  if (suppliedUrl) return suppliedUrl;
  if (store === "steam") return `https://store.steampowered.com/app/${encodeURIComponent(externalId)}`;
  // IDs hexadecimais da Epic não correspondem a uma página; a busca pelo título sempre abre.
  if (title && /^[0-9a-f]{32}$/i.test(String(externalId))) {
    return `https://store.epicgames.com/pt-BR/browse?q=${encodeURIComponent(title)}&sortBy=relevancy`;
  }
  return `https://store.epicgames.com/p/${encodeURIComponent(externalId)}`;
}

function toGameInput(game, source) {
  const igdbId = source === "igdb" && /^\d+$/.test(String(game.externalId))
    ? Number(game.externalId)
    : null;
  return {
    slug: game.slug || `${source}-${game.externalId}`,
    title: game.title || `Jogo ${game.externalId}`,
    summary: game.summary || null,
    coverUrl: game.coverUrl || null,
    heroUrl: game.heroUrl || null,
    igdbId,
    igdbPopularity: Number.isFinite(game.popularity) ? game.popularity : null,
    releasedAt: game.releaseDate || null,
  };
}

/**
 * PostgreSQL implementation used by the sync CLIs. `activeClient` makes the
 * advisory lock session-scoped and serializes the two source snapshots that a
 * rankings job intentionally submits with Promise.all.
 */
export async function createJobRepository({ databaseUrl, pool: suppliedPool } = {}) {
  const pool = suppliedPool ?? createPool(databaseUrl, { allowExitOnIdle: true });
  const repositories = createRepositories(pool);
  let activeClient = null;
  let activeQueue = Promise.resolve();

  function enqueue(work) {
    if (!activeClient) return work(pool);
    const result = activeQueue.then(() => work(activeClient));
    activeQueue = result.catch(() => undefined);
    return result;
  }

  async function transaction(clientOrPool, work) {
    // Correção: um pg.Client também possui `.connect`, então o teste antigo
    // (`typeof connect === "function"`) tentava reconectar o client do advisory
    // lock e todo job falhava com "Client has already been connected".
    if (clientOrPool === pool) return withTransaction(pool, work);
    await clientOrPool.query("BEGIN");
    try {
      const result = await work(clientOrPool);
      await clientOrPool.query("COMMIT");
      return result;
    } catch (error) {
      await clientOrPool.query("ROLLBACK");
      throw error;
    }
  }

  async function catalogUpsert(client, games, source) {
    const saved = [];
    for (const game of games) {
      const fromSeed = source === "seed";
      const persisted = await repositories.games.upsert(toGameInput(game, source), client, { preferExisting: fromSeed });
      const genres = (game.genres ?? []).map((genre) => ({
        slug: genre.slug || genreSlug(genre.name), name: genre.name,
      })).filter((genre) => genre.slug && genre.name);
      // Uma fonte sem gêneros não apaga os gêneros que outra fonte já informou;
      // o seed só preenche gêneros de jogos que ainda não têm nenhum.
      if (genres.length) {
        const hasGenres = fromSeed
          && (await client.query("SELECT 1 FROM game_genres WHERE game_id = $1 LIMIT 1", [persisted.id])).rows.length > 0;
        if (!hasGenres) await repositories.games.replaceGenres(persisted.id, genres, client);
      }
      for (const listing of game.stores ?? []) {
        await repositories.games.upsertListing({
          gameId: persisted.id,
          store: listing.store,
          externalId: listing.externalId,
          url: storeUrl(listing.store, listing.externalId, listing.url),
        }, client);
      }
      saved.push(persisted);
    }
    return saved;
  }

  return {
    async withAdvisoryLock(lockKey, callback) {
      const client = await pool.connect();
      try {
        const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [lockKey]);
        if (!lock.rows[0]?.acquired) return false;
        activeClient = client;
        activeQueue = Promise.resolve();
        try {
          const result = await callback();
          await activeQueue;
          return result;
        } finally {
          activeClient = null;
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
        }
      } finally {
        client.release();
      }
    },

    async startSyncRun({ job, startedAt }) {
      return enqueue(async (client) => {
        const source = job === "catalog" || job === "popularity" ? "igdb" : job;
        const result = await client.query(`INSERT INTO sync_runs (job, source, state, started_at, details)
          VALUES ($1, $2, 'running', $3, '{}'::jsonb) RETURNING id`, [job, source, startedAt]);
        return result.rows[0];
      });
    },

    async finishSyncRun({ id, status, finishedAt, records = 0, error = null }) {
      if (!id) return null;
      return enqueue(async (client) => {
        const state = status === "success" ? "success" : "failed";
        const result = await client.query(`UPDATE sync_runs
          SET state = $2, finished_at = $3, details = jsonb_build_object('records', $4::integer), error_message = $5
          WHERE id = $1 RETURNING id, state`, [id, state, finishedAt, records, error]);
        return result.rows[0] ?? null;
      });
    },

    async upsertCatalogGames(games, { source = "igdb" } = {}) {
      return enqueue((clientOrPool) => transaction(clientOrPool, (client) => catalogUpsert(client, games, source)));
    },

    async replaceRankingSnapshot({ source, capturedAt, entries = [], status = "success" }) {
      return enqueue((clientOrPool) => transaction(clientOrPool, async (client) => {
        const existing = await client.query(`SELECT id FROM ranking_snapshots
          WHERE source = $1 AND captured_at = $2`, [source, capturedAt]);
        // Snapshots are immutable: the first fully committed write wins. A retry
        // for the same capture instant therefore becomes a harmless no-op.
        if (existing.rows[0]) return { id: existing.rows[0].id, inserted: false };

        // Fonte fora do ar: registramos a indisponibilidade (sem entradas) para que o
        // cálculo exclua a fonte, em vez de tratá-la como "todos os jogos com zero".
        if (status === "outage") {
          const outage = await client.query(`INSERT INTO ranking_snapshots (source, status, captured_at, total_entries)
            VALUES ($1, 'outage', $2, 0) RETURNING id`, [source, capturedAt]);
          return { id: outage.rows[0].id, inserted: true, linked: 0 };
        }

        const known = await client.query(`SELECT external_id AS "externalId", game_id AS "gameId"
          FROM store_listings WHERE store = $1 AND external_id = ANY($2::text[])`, [source, entries.map((entry) => String(entry.externalId))]);
        const gameByExternalId = new Map(known.rows.map((row) => [row.externalId, row.gameId]));

        // A Epic não expõe IDs compatíveis com o catálogo; quando o produto ainda não
        // tem vínculo, associamos pelo título normalizado (slug) a um jogo já existente.
        const unlinked = entries.filter((entry) => !gameByExternalId.has(String(entry.externalId)) && entry.title);
        if (source === "epic" && unlinked.length) {
          const slugs = unlinked.map((entry) => genreSlug(entry.title));
          const matches = await client.query(`SELECT id, slug FROM games WHERE slug = ANY($1::text[])`, [slugs]);
          const gameBySlug = new Map(matches.rows.map((row) => [row.slug, row.id]));
          for (const entry of unlinked) {
            const gameId = gameBySlug.get(genreSlug(entry.title));
            if (!gameId) continue;
            await repositories.games.upsertListing({
              gameId, store: "epic", externalId: entry.externalId, url: storeUrl("epic", entry.externalId, entry.url, entry.title),
            }, client);
            gameByExternalId.set(String(entry.externalId), gameId);
          }
        }

        if (source === "epic") {
          // Mantém o link da loja atualizado (corrige vínculos antigos gravados como /p/<id>).
          for (const entry of entries) {
            const gameId = gameByExternalId.get(String(entry.externalId));
            if (!gameId || !entry.title) continue;
            await repositories.games.upsertListing({
              gameId, store: "epic", externalId: entry.externalId, url: storeUrl("epic", entry.externalId, entry.url, entry.title),
            }, client);
          }
        }

        const snapshot = await client.query(`INSERT INTO ranking_snapshots (source, status, captured_at, total_entries)
          VALUES ($1, 'success', $2, $3) RETURNING id`, [source, capturedAt, entries.length]);
        let linked = 0;
        const usedGames = new Set();
        for (const entry of entries) {
          const gameId = gameByExternalId.get(String(entry.externalId));
          // Dois produtos da mesma loja podem apontar para o mesmo jogo (ex.: edições);
          // a chave primária (snapshot, jogo) mantém apenas a melhor posição.
          if (!gameId || usedGames.has(gameId)) continue;
          usedGames.add(gameId);
          linked += 1;
          await client.query(`INSERT INTO ranking_entries (snapshot_id, game_id, position, concurrent_players, metadata)
            VALUES ($1, $2, $3, $4, $5::jsonb)`, [
            snapshot.rows[0].id, gameId, entry.rank, entry.metric ?? null,
            JSON.stringify({ metricName: entry.metricName ?? null, externalId: String(entry.externalId) }),
          ]);
        }
        return { id: snapshot.rows[0].id, inserted: true, linked };
      }));
    },

    /** IDs externos já vinculados a algum jogo (usado para descobrir jogos novos no top da Steam). */
    async listKnownStoreIds(store) {
      return enqueue(async (client) => {
        const result = await client.query("SELECT external_id FROM store_listings WHERE store = $1", [store]);
        return new Set(result.rows.map((row) => row.external_id));
      });
    },

    /**
     * Último snapshot VÁLIDO de cada loja nas últimas `maxAgeHours` horas. Uma falha
     * pontual mantém o último dado bom (como a metodologia descreve); uma loja sem
     * coleta válida dentro da janela fica de fora do cálculo do "agora".
     */
    async loadLatestSnapshots({ asOf = new Date(), maxAgeHours = 24 } = {}) {
      return enqueue(async (client) => {
        const result = await client.query(`
          SELECT DISTINCT ON (s.source) s.source, s.status, s.total_entries AS "totalEntries", s.captured_at AS "capturedAt",
            COALESCE(jsonb_agg(jsonb_build_object('gameId', e.game_id, 'position', e.position, 'concurrentPlayers', e.concurrent_players)
              ORDER BY e.position) FILTER (WHERE e.game_id IS NOT NULL), '[]') AS entries
          FROM ranking_snapshots s LEFT JOIN ranking_entries e ON e.snapshot_id = s.id
          WHERE s.captured_at <= $1 AND s.status = 'success'
            AND s.captured_at > $1::timestamptz - make_interval(hours => $2)
          GROUP BY s.id ORDER BY s.source, s.captured_at DESC`, [asOf, maxAgeHours]);
        return Object.fromEntries(result.rows.map((row) => [row.source, row]));
      });
    },

    /** Para cada um dos 7 dias até `endAt`, o último snapshot de cada loja daquele dia (UTC). */
    async loadDailySnapshots({ endAt = new Date() } = {}) {
      return enqueue(async (client) => {
        // 8 dias de janela: o domínio escolhe exatamente os 7 dias-calendário (UTC).
        const result = await client.query(`
          SELECT DISTINCT ON (snap.day, snap.source) snap.day, snap.source, snap.status, snap."totalEntries", snap.entries
          FROM (
            SELECT to_char(s.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, s.source, s.status, s.captured_at,
              s.total_entries AS "totalEntries",
              COALESCE(jsonb_agg(jsonb_build_object('gameId', e.game_id, 'position', e.position)
                ORDER BY e.position) FILTER (WHERE e.game_id IS NOT NULL), '[]') AS entries
            FROM ranking_snapshots s LEFT JOIN ranking_entries e ON e.snapshot_id = s.id
            WHERE s.captured_at <= $1 AND s.captured_at > $1::timestamptz - interval '8 days'
            GROUP BY s.id
          ) snap
          ORDER BY snap.day, snap.source, (snap.status = 'success') DESC, snap.captured_at DESC`, [endAt]);
        const days = {};
        for (const row of result.rows) {
          days[row.day] ??= {};
          days[row.day][row.source] = { status: row.status, totalEntries: row.totalEntries, entries: row.entries };
        }
        return days;
      });
    },

    /** Lojas em que cada jogo é vendido (vínculos em store_listings). */
    async loadStoreAvailability() {
      return enqueue(async (client) => {
        const result = await client.query("SELECT game_id, array_agg(store::text) AS stores FROM store_listings GROUP BY game_id");
        return new Map(result.rows.map((row) => [row.game_id, new Set(row.stores)]));
      });
    },

    async loadAllTimeCandidates() {
      return enqueue(async (client) => {
        const result = await client.query(`SELECT id, igdb_popularity AS "igdbPopularity" FROM games WHERE igdb_popularity IS NOT NULL`);
        return result.rows.map((row) => ({ id: row.id, igdbPopularity: Number(row.igdbPopularity) }));
      });
    },

    /** Posições do último ranking calculado antes de `before` (para a variação ▲▼). */
    async previousRanks({ period, store, before }) {
      return enqueue(async (client) => {
        const result = await client.query(`
          SELECT game_id AS "gameId", rank FROM game_rankings
          WHERE period = $1 AND store = $2
            AND as_of = (SELECT max(as_of) FROM game_rankings WHERE period = $1 AND store = $2 AND as_of < $3)`,
        [period, store, before]);
        return new Map(result.rows.map((row) => [row.gameId, row.rank]));
      });
    },

    async replaceRankings({ period, store, asOf, entries }) {
      return enqueue((clientOrPool) => transaction(clientOrPool, async (client) => {
        await client.query("DELETE FROM game_rankings WHERE period = $1 AND store = $2 AND as_of = $3", [period, store, asOf]);
        for (const entry of entries) {
          await client.query(`INSERT INTO game_rankings (period, store, game_id, rank, score, metric, trend, source, as_of)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [period, store, entry.gameId, entry.rank, entry.score ?? null, entry.metric ?? null, entry.trend ?? 0, entry.source ?? "steamtwo", asOf]);
        }
        return entries.length;
      }));
    },

    async upsertHistoricalPopularity(entries, { capturedAt } = {}) {
      return enqueue((clientOrPool) => transaction(clientOrPool, async (client) => {
        const saved = await catalogUpsert(client, entries, "igdb");
        for (const game of entries) {
          if (!/^\d+$/.test(String(game.externalId))) continue;
          await client.query(`UPDATE games SET igdb_popularity = $2, updated_at = now()
            WHERE igdb_id = $1`, [Number(game.externalId), Number.isFinite(game.popularity) ? game.popularity : 0]);
        }
        return { records: saved.length, capturedAt };
      }));
    },

    async close() {
      await pool.end();
    },
  };
}
