import { describe, expect, it, vi } from "vitest";
import { syncCatalog, syncPopularity, syncRankings } from "../../server/jobs/index.js";

function repository({ locked = true } = {}) {
  return {
    withAdvisoryLock: vi.fn(async (_key, callback) => locked ? callback() : false),
    startSyncRun: vi.fn(async () => ({ id: "run-1" })),
    finishSyncRun: vi.fn(async () => {}),
    upsertCatalogGames: vi.fn(async () => {}),
    replaceRankingSnapshot: vi.fn(async () => {}),
    upsertHistoricalPopularity: vi.fn(async () => {}),
  };
}

const clock = () => new Date("2026-08-24T12:00:00.000Z");

describe("sync jobs", () => {
  it("persiste catálogo dentro de um advisory lock", async () => {
    const repo = repository();
    const result = await syncCatalog({ repository: repo, igdb: { listCatalog: vi.fn(async () => [{ externalId: "1" }]) }, now: clock });
    expect(result).toMatchObject({ status: "success", records: 1 });
    expect(repo.upsertCatalogGames).toHaveBeenCalledWith([{ externalId: "1" }], expect.objectContaining({ source: "igdb" }));
    expect(repo.finishSyncRun).toHaveBeenLastCalledWith(expect.objectContaining({ status: "success" }));
  });

  it("não executa duas instâncias quando o lock não é adquirido", async () => {
    const repo = repository({ locked: false });
    const result = await syncPopularity({ repository: repo, igdb: { listHistoricalPopularity: vi.fn() }, now: clock });
    expect(result.status).toBe("skipped");
    expect(repo.startSyncRun).not.toHaveBeenCalled();
  });

  it("mantém snapshots Steam e Epic separados e consolida duplicatas Steam", async () => {
    const repo = repository();
    const result = await syncRankings({
      repository: repo,
      now: clock,
      steam: {
        getGamesByConcurrentPlayers: async () => [{ externalId: "730", rank: 2, metric: 10 }],
        getMostPlayedGames: async () => [{ externalId: "730", rank: 1, metric: 20 }],
      },
      epic: { getMostPlayedGames: async () => [{ externalId: "fortnite", rank: 1 }] },
    });
    expect(result).toMatchObject({ records: 2, sources: { steam: { status: "success", entries: 1 }, epic: { status: "success", entries: 1 } } });
    expect(repo.replaceRankingSnapshot).toHaveBeenCalledWith(expect.objectContaining({ source: "steam", entries: [expect.objectContaining({ rank: 1, metric: 20 })] }));
    expect(repo.replaceRankingSnapshot).toHaveBeenCalledWith(expect.objectContaining({ source: "epic" }));
  });

  it("registra outage da Epic sem derrubar a coleta da Steam", async () => {
    const repo = repository();
    const result = await syncRankings({
      repository: repo,
      now: clock,
      steam: {
        getGamesByConcurrentPlayers: async () => [{ externalId: "730", rank: 1, metric: 10 }],
        getMostPlayedGames: async () => [{ externalId: "570", rank: 1, metric: 5 }],
      },
      epic: { getMostPlayedGames: async () => { throw new Error("HTTP 403"); } },
    });
    expect(result.status).toBe("success");
    expect(result.sources.epic).toMatchObject({ status: "outage", error: "HTTP 403" });
    expect(repo.replaceRankingSnapshot).toHaveBeenCalledWith(expect.objectContaining({ source: "epic", status: "outage" }));
    // Fusão Steam renumera as posições 1..N (antes podiam repetir e violar UNIQUE(snapshot, position)).
    const steamCall = repo.replaceRankingSnapshot.mock.calls.find(([input]) => input.source === "steam")[0];
    expect(steamCall.entries.map((entry) => entry.rank)).toEqual([1, 2]);
  });

  it("falha quando Steam e Epic estão fora do ar ao mesmo tempo", async () => {
    const repo = repository();
    const down = async () => { throw new Error("HTTP 502"); };
    await expect(syncRankings({
      repository: repo, now: clock,
      steam: { getGamesByConcurrentPlayers: down, getMostPlayedGames: down },
      epic: { getMostPlayedGames: down },
    })).rejects.toThrow(/indisponíveis/);
    expect(repo.finishSyncRun).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
