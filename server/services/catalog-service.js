import { mockGames, mockUpdatedAt } from "../mock/games.js";

export const WATCHLIST_LIMIT = 100;

export class ServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const storeMatches = (game, store) =>
  store === "all" || game.stores.some((listing) => listing.store === store);

const pagination = (page, limit, total) => ({ page, limit, total, pages: Math.ceil(total / limit) });

function rankingView(game, index, field = "score") {
  return {
    ...game,
    rank: index + 1,
    score: Number(game[field].toFixed(1)),
    metric:
      field === "historicalPopularity"
        ? { type: "popularity", value: game[field], label: "Popularidade histórica" }
        : { type: "players", value: game.currentPlayers, label: "Jogadores Steam" },
    source: field === "historicalPopularity" ? "igdb" : "steamtwo",
    updatedAt: mockUpdatedAt,
  };
}

/**
 * Modo demonstração: sem DATABASE_URL a API continua respondendo com o catálogo
 * de exemplo. Todas as respostas trazem `mode: "demo"` para a interface avisar o
 * usuário — antes, a tela era idêntica com ou sem banco.
 */
function createDemoCatalogService({ games = mockGames } = {}) {
  const lists = new Map();
  const listGames = async () => games;

  return {
    mode: "demo",

    async dashboard({ store = "all" } = {}) {
      const filtered = (await listGames()).filter((game) => storeMatches(game, store));
      const current = [...filtered].sort((a, b) => b.score - a.score);
      const week = current.slice(0, 5).map((game, index) => rankingView(game, index));
      const allTime = [...filtered]
        .sort((a, b) => b.historicalPopularity - a.historicalPopularity)
        .slice(0, 5)
        .map((game, index) => rankingView(game, index, "historicalPopularity"));
      return {
        hero: week[0] ?? null,
        topFive: week,
        week,
        allTime,
        records: allTime.slice(0, 1).map((game) => ({
          type: "historical-score",
          label: "Maior índice SteamTwo",
          value: game.score,
          game,
          achievedAt: mockUpdatedAt,
        })),
        updatedAt: mockUpdatedAt,
        sourceStatus: { steam: "demo", epic: "demo", igdb: "demo" },
        isFallback: true,
        mode: "demo",
      };
    },

    async rankings({ period = "now", store = "all", page = 1, limit = 20 } = {}) {
      const filtered = (await listGames()).filter((game) => storeMatches(game, store));
      const field = period === "all-time" ? "historicalPopularity" : "score";
      const ranked = [...filtered].sort((a, b) => b[field] - a[field]).map((game, index) => rankingView(game, index, field));
      const start = (page - 1) * limit;
      return {
        items: ranked.slice(start, start + limit),
        pagination: pagination(page, limit, ranked.length),
        period,
        store,
        updatedAt: mockUpdatedAt,
        sourceStatus: { steam: "demo", epic: "demo", igdb: "demo" },
        mode: "demo",
      };
    },

    async games({ q = "", genre, store = "all", sort = "popularity", page = 1, limit = 12 } = {}) {
      const normalizedQuery = q.trim().toLocaleLowerCase("pt-BR");
      let filtered = (await listGames()).filter((game) => {
        const matchesQuery = !normalizedQuery || game.title.toLocaleLowerCase("pt-BR").includes(normalizedQuery);
        const matchesGenre = !genre || game.genres.some((item) => item.toLocaleLowerCase("pt-BR") === genre.toLocaleLowerCase("pt-BR"));
        return matchesQuery && matchesGenre && storeMatches(game, store);
      });
      filtered = [...filtered].sort((a, b) =>
        sort === "name" ? a.title.localeCompare(b.title, "pt-BR") : b.score - a.score,
      );
      const start = (page - 1) * limit;
      return {
        items: filtered.slice(start, start + limit),
        pagination: pagination(page, limit, filtered.length),
        filters: { q, genre: genre ?? null, store, sort },
        mode: "demo",
      };
    },

    async game(slug) {
      const game = (await listGames()).find((item) => item.slug === slug);
      return game ? { ...game, updatedAt: mockUpdatedAt, mode: "demo" } : null;
    },

    async genres() {
      const counts = new Map();
      for (const game of await listGames()) for (const genre of game.genres) counts.set(genre, (counts.get(genre) ?? 0) + 1);
      return [...counts].map(([name, total]) => ({ name, games: total })).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    },

    async status() {
      return { mode: "demo", database: "not-configured", counts: { games: games.length }, lastRuns: [], sources: { steam: "demo", epic: "demo", igdb: "demo" } };
    },

    watchlist: {
      async list(listId) {
        const slugs = lists.get(listId) ?? [];
        return slugs.map((slug) => games.find((game) => game.slug === slug)).filter(Boolean);
      },
      async add(listId, slug) {
        if (!games.some((game) => game.slug === slug)) throw new ServiceError("Jogo não encontrado", 404);
        const slugs = lists.get(listId) ?? [];
        if (slugs.includes(slug)) return { added: false };
        if (slugs.length >= WATCHLIST_LIMIT) throw new ServiceError(`A lista aceita no máximo ${WATCHLIST_LIMIT} jogos`, 409);
        lists.set(listId, [slug, ...slugs]);
        return { added: true };
      },
      async remove(listId, slug) {
        const slugs = lists.get(listId) ?? [];
        lists.set(listId, slugs.filter((item) => item !== slug));
        return { removed: slugs.includes(slug) };
      },
    },
  };
}

/** Modo banco: tudo vem do PostgreSQL (rankings calculados pelo job `scores`). */
function createDatabaseCatalogService({ repository }) {
  return {
    mode: "database",

    async dashboard({ store = "all" } = {}) {
      const [now, week, allTime, record, updatedAt, sources] = await Promise.all([
        repository.ranking({ period: "now", store, limit: 5 }),
        repository.ranking({ period: "week", store, limit: 5 }),
        repository.ranking({ period: "all-time", store, limit: 5 }),
        repository.bestRecord(),
        repository.latestAsOf("now", "all"),
        repository.sourceStatus(),
      ]);
      return {
        hero: now.items[0] ?? null,
        topFive: now.items,
        week: week.items,
        allTime: allTime.items,
        records: record ? [{ type: "monitored-record", label: "Maior índice SteamTwo", ...record }] : [],
        updatedAt,
        sourceStatus: { steam: sources.steam, epic: sources.epic, igdb: sources.igdb },
        isFallback: false,
        mode: "database",
      };
    },

    async rankings({ period = "now", store = "all", page = 1, limit = 20 } = {}) {
      const [{ items, total }, sources] = await Promise.all([
        repository.ranking({ period, store, limit, offset: (page - 1) * limit }),
        repository.sourceStatus(),
      ]);
      return {
        items,
        pagination: pagination(page, limit, total),
        period,
        store,
        updatedAt: items[0]?.updatedAt ?? null,
        sourceStatus: { steam: sources.steam, epic: sources.epic, igdb: sources.igdb },
        mode: "database",
      };
    },

    async games({ q = "", genre, store = "all", sort = "popularity", page = 1, limit = 12 } = {}) {
      const { items, total } = await repository.searchGames({ q, genre, store, sort, limit, offset: (page - 1) * limit });
      return { items, pagination: pagination(page, limit, total), filters: { q, genre: genre ?? null, store, sort }, mode: "database" };
    },

    async game(slug) {
      const game = await repository.getGame(slug);
      return game ? { ...game, mode: "database" } : null;
    },

    genres: () => repository.listGenres(),

    async status() {
      return { mode: "database", database: "connected", ...(await repository.status()) };
    },

    watchlist: {
      list: (listId) => repository.watchlist.list(listId),
      async add(listId, slug) {
        if ((await repository.watchlist.count(listId)) >= WATCHLIST_LIMIT) {
          throw new ServiceError(`A lista aceita no máximo ${WATCHLIST_LIMIT} jogos`, 409);
        }
        const found = await repository.watchlist.add(listId, slug);
        if (!found) throw new ServiceError("Jogo não encontrado", 404);
        return { added: true };
      },
      async remove(listId, slug) {
        return { removed: await repository.watchlist.remove(listId, slug) };
      },
    },
  };
}

export function createCatalogService({ repository, games } = {}) {
  return repository ? createDatabaseCatalogService({ repository }) : createDemoCatalogService({ games });
}
