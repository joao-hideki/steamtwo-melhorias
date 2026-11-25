import { withTransaction } from "./pool.js";

/**
 * Consultas de leitura da API. Filtros, ordenação e paginação acontecem no
 * PostgreSQL (antes o serviço carregava o catálogo inteiro e filtrava em memória).
 * Todos os valores do usuário entram por placeholders ($1, $2...).
 */
const STORE_LABEL = "CASE WHEN sl.store = 'steam' THEN 'Steam' ELSE 'Epic Games' END";
const FRESH_HOURS = 26;

/**
 * Instante do cálculo "atual": o último job `scores` bem-sucedido (registrado em sync_runs),
 * mesmo que ele não tenha gerado linhas — assim um cálculo vazio (nenhuma loja com dado
 * válido) não deixa a API exibindo o ranking anterior como se fosse atual. Sem histórico
 * de jobs (dados inseridos à mão), vale o ranking mais recente da tabela.
 */
const currentAsOf = (period, store) => `COALESCE(
  (SELECT max(started_at) FROM sync_runs WHERE job = 'scores' AND state = 'success'),
  (SELECT max(as_of) FROM game_rankings WHERE period = ${period} AND store = ${store}))`;

const GAME_FIELDS = `
  g.id, g.slug, g.title, g.summary,
  g.cover_url AS "coverUrl", g.hero_url AS "heroUrl", g.released_at AS "releaseDate",
  g.igdb_popularity AS "historicalPopularity",
  COALESCE((SELECT array_agg(ge.name ORDER BY ge.name) FROM game_genres gg JOIN genres ge ON ge.id = gg.genre_id
    WHERE gg.game_id = g.id), '{}') AS genres,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('store', sl.store, 'label', ${STORE_LABEL}, 'url', sl.url) ORDER BY sl.store)
    FROM store_listings sl WHERE sl.game_id = g.id), '[]'::jsonb) AS stores`;

/** Índice atual (ranking "agora" combinado) e jogadores Steam do último snapshot válido. */
const CURRENT_METRICS = `
  LEFT JOIN LATERAL (
    SELECT score, trend, rank FROM game_rankings
    WHERE game_id = g.id AND period = 'now' AND store = 'all'
      AND as_of = ${currentAsOf("'now'", "'all'")}
  ) cur ON true
  LEFT JOIN LATERAL (
    SELECT re.concurrent_players FROM ranking_entries re JOIN ranking_snapshots rs ON rs.id = re.snapshot_id
    WHERE re.game_id = g.id AND rs.source = 'steam' AND rs.status = 'success'
    ORDER BY rs.captured_at DESC LIMIT 1
  ) players ON true`;

const toNumber = (value) => (value == null ? null : Number(value));

function mapGame(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? "",
    coverUrl: row.coverUrl,
    heroUrl: row.heroUrl,
    genres: row.genres ?? [],
    releaseDate: row.releaseDate,
    stores: row.stores ?? [],
    score: toNumber(row.score) ?? 0,
    trend: Number(row.trend ?? 0),
    currentRank: toNumber(row.currentRank),
    currentPlayers: toNumber(row.currentPlayers),
    historicalPopularity: toNumber(row.historicalPopularity) ?? 0,
  };
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function createCatalogReadRepository(pool) {
  async function latestAsOf(period, store) {
    const result = await pool.query(`SELECT ${currentAsOf("$1::ranking_period", "$2")} AS as_of`, [period, store]);
    return result.rows[0]?.as_of ?? null;
  }

  async function ranking({ period, store = "all", limit = 20, offset = 0 }) {
    // "De sempre" é calculado só para "all" (popularidade histórica não é por loja);
    // ao filtrar por loja, mantemos a ordem e renumeramos as posições.
    const rankingStore = period === "all-time" ? "all" : store;
    const storeFilter = period === "all-time" && store !== "all" ? store : null;
    const result = await pool.query(`
      WITH latest AS (SELECT ${currentAsOf("$1", "$2")} AS as_of),
      ranked AS (
        SELECT r.*, row_number() OVER (ORDER BY r.rank) AS position
        FROM game_rankings r JOIN latest l ON r.as_of = l.as_of
        WHERE r.period = $1 AND r.store = $2
          AND ($3::store_name IS NULL OR EXISTS (SELECT 1 FROM store_listings x WHERE x.game_id = r.game_id AND x.store = $3::store_name))
      )
      SELECT r.position AS rank, r.score, r.metric, r.trend, r.source, r.as_of AS "updatedAt",
        count(*) OVER () AS total, players.concurrent_players AS "currentPlayers", cur.rank AS "currentRank", ${GAME_FIELDS}
      FROM ranked r JOIN games g ON g.id = r.game_id
      LEFT JOIN LATERAL (
        SELECT c.rank FROM game_rankings c WHERE c.game_id = g.id AND c.period = 'now' AND c.store = 'all'
          AND c.as_of = ${currentAsOf("'now'", "'all'")}
      ) cur ON true
      LEFT JOIN LATERAL (
        SELECT re.concurrent_players FROM ranking_entries re JOIN ranking_snapshots rs ON rs.id = re.snapshot_id
        WHERE re.game_id = g.id AND rs.source = 'steam' AND rs.status = 'success' ORDER BY rs.captured_at DESC LIMIT 1
      ) players ON true
      ORDER BY r.position LIMIT $4 OFFSET $5`, [period, rankingStore, storeFilter, limit, offset]);
    return {
      total: Number(result.rows[0]?.total ?? 0),
      items: result.rows.map((row) => ({
        ...mapGame(row),
        rank: Number(row.rank),
        score: Number(Number(row.score ?? 0).toFixed(1)),
        trend: Number(row.trend ?? 0),
        metric: period === "all-time"
          ? row.source === "igdb"
            ? { type: "popularity", value: toNumber(row.metric), label: "Popularidade histórica (IGDB)" }
            : { type: "peak", value: toNumber(row.metric), label: "Maior índice já registrado" }
          : period === "week"
            ? { type: "days", value: toNumber(row.metric), label: "Dias válidos na semana" }
            : { type: "players", value: toNumber(row.currentPlayers), label: "Jogadores Steam" },
        source: row.source,
        updatedAt: row.updatedAt,
      })),
    };
  }

  async function sourceStatus() {
    const snapshots = await pool.query(`
      SELECT DISTINCT ON (source) source, status, captured_at AS "capturedAt", total_entries AS "totalEntries"
      FROM ranking_snapshots ORDER BY source, captured_at DESC`);
    const igdb = await pool.query(`SELECT state FROM sync_runs WHERE job IN ('catalog', 'popularity')
      ORDER BY started_at DESC LIMIT 1`);
    const freshness = (row) => {
      if (!row || row.status === "outage") return "unavailable";
      const ageHours = (Date.now() - new Date(row.capturedAt).getTime()) / 3_600_000;
      return ageHours <= FRESH_HOURS ? "fresh" : "stale";
    };
    const bySource = Object.fromEntries(snapshots.rows.map((row) => [row.source, row]));
    return {
      steam: freshness(bySource.steam),
      epic: freshness(bySource.epic),
      // IGDB é opcional (exige credenciais Twitch): sem nenhuma execução, "não configurada".
      igdb: !igdb.rows[0] ? "not-configured" : igdb.rows[0].state === "success" ? "fresh" : "unavailable",
      details: bySource,
    };
  }

  return {
    ranking,
    latestAsOf,
    sourceStatus,

    async searchGames({ q = "", genre, store = "all", sort = "popularity", limit = 12, offset = 0 }) {
      const params = [];
      const where = [];
      if (q.trim()) {
        params.push(`%${escapeLike(q.trim())}%`);
        where.push(`g.title ILIKE $${params.length}`);
      }
      if (genre) {
        params.push(genre);
        where.push(`EXISTS (SELECT 1 FROM game_genres fg JOIN genres fge ON fge.id = fg.genre_id
          WHERE fg.game_id = g.id AND lower(fge.name) = lower($${params.length}))`);
      }
      if (store !== "all") {
        params.push(store);
        where.push(`EXISTS (SELECT 1 FROM store_listings fs WHERE fs.game_id = g.id AND fs.store = $${params.length}::store_name)`);
      }
      const order = sort === "name"
        ? "g.title ASC"
        : "cur.rank ASC NULLS LAST, COALESCE(g.igdb_popularity, 0) DESC, g.title ASC";
      params.push(limit, offset);
      const result = await pool.query(`
        SELECT ${GAME_FIELDS}, cur.score, cur.trend, cur.rank AS "currentRank",
          players.concurrent_players AS "currentPlayers", count(*) OVER () AS total
        FROM games g ${CURRENT_METRICS}
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${order}
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
      return { total: Number(result.rows[0]?.total ?? 0), items: result.rows.map(mapGame) };
    },

    async getGame(slug) {
      const result = await pool.query(`
        SELECT ${GAME_FIELDS}, cur.score, cur.trend, cur.rank AS "currentRank", players.concurrent_players AS "currentPlayers",
          (SELECT max(as_of) FROM game_rankings WHERE game_id = g.id) AS "updatedAt"
        FROM games g ${CURRENT_METRICS} WHERE g.slug = $1`, [slug]);
      return result.rows[0] ? { ...mapGame(result.rows[0]), updatedAt: result.rows[0].updatedAt } : null;
    },

    async listGenres() {
      const result = await pool.query(`SELECT ge.name, count(*)::int AS games FROM genres ge
        JOIN game_genres gg ON gg.genre_id = ge.id GROUP BY ge.name ORDER BY ge.name`);
      return result.rows;
    },

    async bestRecord() {
      const result = await pool.query(`
        SELECT r.score, r.as_of AS "achievedAt", ${GAME_FIELDS}
        FROM game_rankings r JOIN games g ON g.id = r.game_id
        WHERE r.period = 'now' AND r.store = 'all' ORDER BY r.score DESC, r.as_of ASC LIMIT 1`);
      const row = result.rows[0];
      return row ? { value: Number(Number(row.score).toFixed(1)), achievedAt: row.achievedAt, game: mapGame(row) } : null;
    },

    async status() {
      const [counts, runs, sources] = await Promise.all([
        pool.query(`SELECT (SELECT count(*) FROM games)::int AS games,
          (SELECT count(*) FROM store_listings)::int AS listings,
          (SELECT count(*) FROM ranking_snapshots)::int AS snapshots,
          (SELECT count(*) FROM game_rankings)::int AS rankings,
          (SELECT count(*) FROM watchlist_items)::int AS "watchlistItems"`),
        pool.query(`SELECT DISTINCT ON (job) job, state, started_at AS "startedAt", finished_at AS "finishedAt",
          details, error_message AS error FROM sync_runs ORDER BY job, started_at DESC`),
        sourceStatus(),
      ]);
      return { counts: counts.rows[0], lastRuns: runs.rows, sources };
    },

    watchlist: {
      async list(listId) {
        const result = await pool.query(`
          SELECT ${GAME_FIELDS}, cur.score, cur.trend, cur.rank AS "currentRank",
            players.concurrent_players AS "currentPlayers", w.added_at AS "addedAt"
          FROM watchlist_items w JOIN games g ON g.id = w.game_id ${CURRENT_METRICS}
          WHERE w.list_id = $1 ORDER BY w.added_at DESC`, [listId]);
        return result.rows.map((row) => ({ ...mapGame(row), addedAt: row.addedAt }));
      },
      async count(listId) {
        const result = await pool.query("SELECT count(*)::int AS total FROM watchlist_items WHERE list_id = $1", [listId]);
        return result.rows[0].total;
      },
      /**
       * Resultado: "not-found" | "exists" (idempotente) | "full" (limite) | "added".
       * Requisições concorrentes para a MESMA lista são serializadas por um advisory
       * lock de transação (pg_advisory_xact_lock): a contagem, a verificação de
       * duplicata e o INSERT enxergam o estado já confirmado pela requisição anterior.
       * Uma única instrução com CTE não basta — no READ COMMITTED, dois PUTs simultâneos
       * veriam a lista "sem o jogo" e o perdedor do ON CONFLICT viraria um falso "cheia".
       */
      async add(listId, slug, limit) {
        return withTransaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('steamtwo:watchlist:' || $1))", [listId]);
          const game = await client.query("SELECT id FROM games WHERE slug = $1", [slug]);
          if (!game.rows[0]) return "not-found";
          const state = await client.query(`SELECT
              EXISTS (SELECT 1 FROM watchlist_items WHERE list_id = $1 AND game_id = $2) AS already,
              (SELECT count(*) FROM watchlist_items WHERE list_id = $1)::int AS total`, [listId, game.rows[0].id]);
          if (state.rows[0].already) return "exists";
          if (state.rows[0].total >= limit) return "full";
          await client.query("INSERT INTO watchlist_items (list_id, game_id) VALUES ($1, $2)", [listId, game.rows[0].id]);
          return "added";
        });
      },
      async remove(listId, slug) {
        const result = await pool.query(`DELETE FROM watchlist_items w USING games g
          WHERE w.game_id = g.id AND w.list_id = $1 AND g.slug = $2`, [listId, slug]);
        return result.rowCount > 0;
      },
    },
  };
}
