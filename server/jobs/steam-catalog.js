import { runLockedSync } from "./run-job.js";

/**
 * Descobre jogos do top da Steam que ainda não estão no catálogo e busca os dados
 * públicos de cada um (nome, descrição, capas e gêneros) na loja. Assim o catálogo
 * cresce com dados reais mesmo sem as credenciais da IGDB.
 */
export async function syncSteamCatalog({ repository, steam, steamStore, limit = 40, now } = {}) {
  if (!steam?.getMostPlayedGames || !steamStore?.getManyAppDetails) {
    throw new Error("Clientes Steam (charts e loja) são obrigatórios");
  }
  return runLockedSync({
    repository,
    job: "steam-catalog",
    lockKey: "steamtwo:sync:steam-catalog",
    now,
    execute: async ({ capturedAt }) => {
      // Basta um dos dois rankings responder para descobrir jogos novos.
      const lists = await Promise.allSettled([
        steam.getMostPlayedGames(),
        steam.getGamesByConcurrentPlayers ? steam.getGamesByConcurrentPlayers() : Promise.resolve([]),
      ]);
      const fulfilled = lists.filter((result) => result.status === "fulfilled").map((result) => result.value);
      if (!fulfilled.length) throw lists[0].reason;
      const known = await repository.listKnownStoreIds("steam");
      const ranked = fulfilled.flat().sort((a, b) => a.rank - b.rank);
      const missing = [...new Set(ranked.map((entry) => String(entry.externalId)))]
        .filter((appId) => !known.has(appId))
        .slice(0, limit);
      const { games, failures } = await steamStore.getManyAppDetails(missing);
      if (games.length) await repository.upsertCatalogGames(games, { source: "steam", capturedAt });
      return { records: games.length, capturedAt, discovered: missing.length, failures: failures.length };
    },
  });
}
