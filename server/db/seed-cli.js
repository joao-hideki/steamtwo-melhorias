import { runSeed } from "./seed.js";

try {
  const result = await runSeed();
  console.log(`Seed concluído: ${result.games} jogos do catálogo inicial.`);
} catch (error) {
  console.error(`Falha no seed: ${error.message}`);
  process.exitCode = 1;
}
