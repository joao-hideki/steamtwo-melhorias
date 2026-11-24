import { config } from "../config.js";
import { createEpicClient, createIgdbClient, createSteamClient, createSteamStoreClient } from "../integrations/index.js";
import { syncCatalog, syncPopularity, syncRankings, syncScores, syncSteamCatalog } from "./index.js";

const command = process.argv[2];
const everyFlag = process.argv.indexOf("--every");
const intervalMinutes = everyFlag > 0 ? Number(process.argv[everyFlag + 1]) : 0;
const commands = new Set(["catalog", "rankings", "popularity", "scores", "steam-catalog", "all"]);

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function runCommand(name, repository) {
  const steam = createSteamClient({ countryCode: config.steamCountry });
  const epic = createEpicClient({ locale: config.epicLocale });
  const igdb = createIgdbClient({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret });
  const steamStore = createSteamStoreClient({ countryCode: config.steamCountry });
  switch (name) {
    case "catalog": return syncCatalog({ repository, igdb });
    case "popularity": return syncPopularity({ repository, igdb });
    case "rankings": return syncRankings({ repository, steam, epic });
    case "scores": return syncScores({ repository });
    case "steam-catalog": return syncSteamCatalog({ repository, steam, steamStore });
    default: throw new Error(`comando desconhecido: ${name}`);
  }
}

/**
 * `all` executa o pipeline completo sem depender da IGDB:
 * descobrir jogos na Steam → coletar rankings Steam/Epic → recalcular o índice.
 * Uma etapa com falha é registrada (sync_runs) e as seguintes continuam.
 */
async function runAll(repository) {
  const steps = ["steam-catalog", "rankings", "scores"];
  let failures = 0;
  for (const step of steps) {
    try {
      log(`${step}: ${JSON.stringify(await runCommand(step, repository))}`);
    } catch (error) {
      failures += 1;
      log(`${step}: falhou — ${error.message}`);
    }
  }
  return failures;
}

if (!commands.has(command)) {
  console.error("Uso: node server/jobs/cli.js <catalog|rankings|popularity|scores|steam-catalog|all> [--every <minutos>]");
  process.exitCode = 1;
} else {
  // O repositório é separado do job para deixar integrações testáveis e
  // permitir que a camada PostgreSQL defina transações e advisory locks.
  const module = await import("../db/job-repository.js");
  const repository = await module.createJobRepository({ databaseUrl: config.databaseUrl });
  const runOnce = async () => {
    if (command === "all") return runAll(repository);
    try {
      log(`${command}: ${JSON.stringify(await runCommand(command, repository))}`);
      return 0;
    } catch (error) {
      log(`Falha no sync ${command}: ${error.message}`);
      return 1;
    }
  };

  if (intervalMinutes > 0) {
    // Modo agendador (serviço `sync` do docker compose): roda agora e a cada N minutos.
    log(`agendador iniciado: "${command}" a cada ${intervalMinutes} min`);
    await runOnce();
    setInterval(runOnce, intervalMinutes * 60_000);
  } else {
    process.exitCode = (await runOnce()) > 0 ? 1 : 0;
    await repository.close();
  }
}
