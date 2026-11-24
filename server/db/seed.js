import { config } from "../config.js";
import { mockGames } from "../mock/games.js";
import { createJobRepository } from "./job-repository.js";

/** Extrai o appid da URL da loja Steam (ex.: https://store.steampowered.com/app/730/...). */
export function steamAppIdFromUrl(url) {
  const match = /store\.steampowered\.com\/app\/(\d+)/.exec(url ?? "");
  return match ? match[1] : null;
}

/**
 * Converte o catálogo de demonstração para o formato aceito por `upsertCatalogGames`.
 * Apenas vínculos Steam com appid real entram como listing: os vínculos da Epic são
 * criados automaticamente pela coleta, que associa o título do ranking ao jogo.
 */
export function seedCatalog(games = mockGames) {
  return games.map((game) => ({
    slug: game.slug,
    title: game.title,
    summary: game.summary,
    coverUrl: game.coverUrl,
    heroUrl: game.heroUrl,
    releaseDate: game.releaseDate,
    popularity: game.historicalPopularity,
    genres: game.genres.map((name) => ({ name })),
    stores: game.stores
      .map((listing) => listing.store === "steam"
        ? { store: "steam", externalId: steamAppIdFromUrl(listing.url), url: listing.url }
        : null)
      .filter((listing) => listing?.externalId),
  }));
}

/** Idempotente: pode rodar a cada `docker compose up` sem duplicar dados. */
export async function runSeed({ databaseUrl = config.databaseUrl } = {}) {
  const repository = await createJobRepository({ databaseUrl });
  try {
    const games = seedCatalog();
    await repository.upsertCatalogGames(games, { source: "seed" });
    return { games: games.length };
  } finally {
    await repository.close();
  }
}
