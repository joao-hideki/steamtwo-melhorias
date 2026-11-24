import { describe, expect, it, vi } from "vitest";
import { normalizeSteamAppDetails } from "../../server/integrations/steam-store-client.js";
import { syncScores, syncSteamCatalog } from "../../server/jobs/index.js";

const clock = () => new Date("2026-11-20T12:00:00.000Z");

function repository(overrides = {}) {
  return {
    withAdvisoryLock: vi.fn(async (_key, callback) => callback()),
    startSyncRun: vi.fn(async () => ({ id: "run-1" })),
    finishSyncRun: vi.fn(async () => undefined),
    replaceRankings: vi.fn(async () => undefined),
    previousRanks: vi.fn(async () => new Map()),
    loadAllTimeCandidates: vi.fn(async () => [{ id: "a", igdbPopularity: 10 }, { id: "b", igdbPopularity: 90 }]),
    loadDailySnapshots: vi.fn(async () => ({})),
    loadLatestSnapshots: vi.fn(async () => ({
      steam: { status: "success", totalEntries: 2, entries: [{ gameId: "a", position: 1, concurrentPlayers: 500 }, { gameId: "b", position: 2, concurrentPlayers: 100 }] },
      epic: { status: "success", totalEntries: 1, entries: [{ gameId: "b", position: 1 }] },
    })),
    ...overrides,
  };
}

describe("job scores (Índice SteamTwo)", () => {
  it("gera rankings agora/semana por loja e de sempre", async () => {
    const repo = repository();
    const result = await syncScores({ repository: repo, now: clock });
    expect(result.status).toBe("success");
    const calls = repo.replaceRankings.mock.calls.map(([input]) => `${input.period}/${input.store}`);
    expect(calls).toEqual(["now/all", "week/all", "now/steam", "week/steam", "now/epic", "week/epic", "all-time/all"]);

    const nowAll = repo.replaceRankings.mock.calls[0][0].entries;
    // b: Steam 50 + Epic 100 → 75; a: Steam 100 + Epic ausente (0) → 50.
    expect(nowAll.map((entry) => [entry.gameId, entry.score])).toEqual([["b", 75], ["a", 50]]);
    expect(nowAll[1].metric).toBe(500); // jogadores Steam do último snapshot

    const allTime = repo.replaceRankings.mock.calls.at(-1)[0].entries;
    expect(allTime.map((entry) => entry.gameId)).toEqual(["b", "a"]);
  });

  it("calcula a variação (trend) contra o ranking anterior", async () => {
    const repo = repository({ previousRanks: vi.fn(async ({ period }) => new Map(period === "now" ? [["b", 2], ["a", 1]] : [])) });
    await syncScores({ repository: repo, now: clock });
    const nowAll = repo.replaceRankings.mock.calls[0][0].entries;
    expect(nowAll.find((entry) => entry.gameId === "b").trend).toBe(1); // subiu do 2º para o 1º
    expect(nowAll.find((entry) => entry.gameId === "a").trend).toBe(-1);
  });

  it("exclui loja sem snapshot válido em vez de zerar os jogos", async () => {
    const repo = repository({ loadLatestSnapshots: vi.fn(async () => ({ steam: { status: "success", totalEntries: 1, entries: [{ gameId: "a", position: 1 }] } })) });
    await syncScores({ repository: repo, now: clock });
    expect(repo.replaceRankings.mock.calls[0][0].entries).toEqual([expect.objectContaining({ gameId: "a", score: 100 })]);
  });
});

describe("catálogo automático pela loja Steam", () => {
  it("normaliza appdetails (nome, resumo sem HTML, gêneros e vínculo)", () => {
    const game = normalizeSteamAppDetails(730, {
      730: { success: true, data: { name: "Counter-Strike 2", short_description: "Tiro <b>tático</b> &amp; competitivo", genres: [{ description: "Ação" }, { description: "Gratuito para jogar" }] } },
    });
    expect(game).toMatchObject({
      slug: "counter-strike-2",
      summary: "Tiro tático & competitivo",
      genres: [{ name: "Ação" }, { name: "Gratuito para jogar" }],
      stores: [{ store: "steam", externalId: "730" }],
    });
  });

  it("ignora apps sem dados na loja", () => {
    expect(normalizeSteamAppDetails(1, { 1: { success: false } })).toBeNull();
  });

  it("busca detalhes só dos apps do top que ainda não estão no catálogo", async () => {
    const repo = {
      ...repository(),
      listKnownStoreIds: vi.fn(async () => new Set(["730"])),
      upsertCatalogGames: vi.fn(async () => undefined),
    };
    const steamStore = { getManyAppDetails: vi.fn(async (ids) => ({ games: ids.map((id) => ({ externalId: id, title: `Jogo ${id}` })), failures: [] })) };
    const result = await syncSteamCatalog({
      repository: repo, steamStore, now: clock, limit: 5,
      steam: {
        getMostPlayedGames: async () => [{ externalId: "730", rank: 1 }, { externalId: "570", rank: 2 }],
        getGamesByConcurrentPlayers: async () => { throw new Error("HTTP 502"); },
      },
    });
    expect(steamStore.getManyAppDetails).toHaveBeenCalledWith(["570"]);
    expect(result).toMatchObject({ status: "success", records: 1, discovered: 1 });
  });
});
