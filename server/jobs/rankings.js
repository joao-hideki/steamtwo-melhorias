import { runLockedSync } from "./run-job.js";

function mergeSteamEntries(lists) {
  // Os dois endpoints Steam podem conter conjuntos diferentes; mantemos o
  // maior valor de jogadores e a melhor posição para cada app no snapshot.
  const mergedSteam = new Map();
  for (const entry of lists.flat()) {
    const current = mergedSteam.get(entry.externalId);
    mergedSteam.set(entry.externalId, {
      ...current,
      ...entry,
      rank: Math.min(current?.rank ?? Infinity, entry.rank ?? Infinity),
      metric: Math.max(current?.metric ?? 0, entry.metric ?? 0) || null,
    });
  }
  // Reposiciona 1..N após a fusão para não haver posições repetidas no snapshot.
  return [...mergedSteam.values()].sort((a, b) => a.rank - b.rank).map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export async function syncRankings({ repository, steam, epic, now } = {}) {
  if (!steam?.getGamesByConcurrentPlayers || !steam?.getMostPlayedGames || !epic?.getMostPlayedGames) {
    throw new Error("Clientes Steam e Epic completos são obrigatórios");
  }
  return runLockedSync({
    repository,
    job: "rankings",
    lockKey: "steamtwo:sync:rankings",
    now,
    execute: async ({ capturedAt }) => {
      const [concurrent, mostPlayed, epicResult] = await Promise.allSettled([
        steam.getGamesByConcurrentPlayers(), steam.getMostPlayedGames(), epic.getMostPlayedGames(),
      ]);
      const steamLists = [mostPlayed, concurrent].filter((result) => result.status === "fulfilled").map((result) => result.value);
      const steamEntries = steamLists.length ? mergeSteamEntries(steamLists) : [];
      const epicEntries = epicResult.status === "fulfilled" ? epicResult.value : [];

      // Uma loja fora do ar não derruba a coleta da outra: ela vira um snapshot
      // "outage", que o cálculo do índice exclui (em vez de zerar todos os jogos).
      const sources = {
        steam: steamLists.length ? { status: "success", entries: steamEntries.length } : { status: "outage", error: mostPlayed.reason?.message },
        epic: epicResult.status === "fulfilled" ? { status: "success", entries: epicEntries.length } : { status: "outage", error: epicResult.reason?.message },
      };
      if (sources.steam.status === "outage" && sources.epic.status === "outage") {
        throw new Error(`Steam e Epic indisponíveis (${sources.steam.error}; ${sources.epic.error})`);
      }
      const [steamSnapshot, epicSnapshot] = await Promise.all([
        repository.replaceRankingSnapshot({ source: "steam", capturedAt, entries: steamEntries, status: sources.steam.status }),
        repository.replaceRankingSnapshot({ source: "epic", capturedAt, entries: epicEntries, status: sources.epic.status }),
      ]);
      sources.steam.linked = steamSnapshot?.linked ?? null;
      sources.epic.linked = epicSnapshot?.linked ?? null;
      return { records: steamEntries.length + epicEntries.length, capturedAt, sources };
    },
  });
}
