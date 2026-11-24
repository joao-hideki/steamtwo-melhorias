import { calculateScoresByGame, calculateWeeklyScores, createAllTimeRanking } from "../domain/ranking/index.js";
import { runLockedSync } from "./run-job.js";

const STORES = ["all", "steam", "epic"];
const MAX_POSITIONS = 100;

/** Recorta os snapshots de uma loja; "all" combina Steam e Epic. */
function forStore(snapshots, store) {
  if (store === "all") return snapshots ?? {};
  return snapshots?.[store] ? { [store]: snapshots[store] } : {};
}

function withTrend(entries, previous, extra = () => ({})) {
  return entries.slice(0, MAX_POSITIONS).map((item) => ({
    gameId: item.gameId,
    rank: item.rank,
    score: Number(item.score.toFixed(4)),
    // Variação positiva = subiu de posição em relação ao cálculo anterior.
    trend: previous.has(item.gameId) ? previous.get(item.gameId) - item.rank : 0,
    ...extra(item),
  }));
}

/**
 * Transforma os snapshots brutos das lojas em `game_rankings` usando as regras do
 * domínio (Índice SteamTwo). Antes deste job os snapshots eram gravados, mas nada
 * os convertia em ranking — por isso o dashboard ficava vazio com o banco ligado.
 */
export async function syncScores({ repository, now } = {}) {
  if (!repository?.loadLatestSnapshots) throw new Error("repository.loadLatestSnapshots é obrigatório");
  return runLockedSync({
    repository,
    job: "scores",
    lockKey: "steamtwo:sync:scores",
    now,
    execute: async ({ capturedAt }) => {
      const [latest, daily, allTimeGames, availability] = await Promise.all([
        repository.loadLatestSnapshots({ asOf: capturedAt }),
        repository.loadDailySnapshots({ endAt: capturedAt }),
        repository.loadAllTimeCandidates(),
        // Ausência só vale zero numa loja que vende o jogo (ver domain/ranking).
        repository.loadStoreAvailability ? repository.loadStoreAvailability() : undefined,
      ]);
      const steamPlayers = new Map((latest.steam?.entries ?? []).map((entry) => [entry.gameId, entry.concurrentPlayers]));
      const counts = {};

      for (const store of STORES) {
        const current = calculateScoresByGame(forStore(latest, store), { availability });
        const previousNow = await repository.previousRanks({ period: "now", store, before: capturedAt });
        await repository.replaceRankings({
          period: "now", store, asOf: capturedAt,
          entries: withTrend(current, previousNow, (item) => ({ metric: steamPlayers.get(item.gameId) ?? null })),
        });

        const dailyForStore = Object.fromEntries(Object.entries(daily).map(([day, snapshots]) => [day, forStore(snapshots, store)]));
        const week = calculateWeeklyScores({ dailySnapshots: dailyForStore, endAt: capturedAt, availability });
        const previousWeek = await repository.previousRanks({ period: "week", store, before: capturedAt });
        await repository.replaceRankings({
          period: "week", store, asOf: capturedAt,
          entries: withTrend(week, previousWeek, (item) => ({ metric: item.validDays })),
        });
        counts[store] = { now: current.length, week: week.length };
      }

      // "De sempre" depende da popularidade histórica (IGDB/seed) e não de loja.
      const allTime = createAllTimeRanking(allTimeGames);
      await repository.replaceRankings({
        period: "all-time", store: "all", asOf: capturedAt,
        entries: allTime.slice(0, MAX_POSITIONS).map((item) => ({ ...item, trend: 0 })),
      });
      counts.allTime = allTime.length;

      // records = linhas efetivamente gravadas em game_rankings (todas as lojas e períodos).
      const records = STORES.reduce((sum, store) => sum + Math.min(counts[store].now, MAX_POSITIONS) + Math.min(counts[store].week, MAX_POSITIONS), 0)
        + Math.min(counts.allTime, MAX_POSITIONS);
      return { records, capturedAt, counts };
    },
  });
}
