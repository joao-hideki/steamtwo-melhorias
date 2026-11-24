import { Router } from "express";
import { z } from "zod";
import { createCatalogService } from "../services/catalog-service.js";

const storeSchema = z.enum(["all", "steam", "epic"]).default("all");
const periodSchema = z.enum(["now", "week", "all-time"]).default("now");
const pageSchema = z.coerce.number().int().min(1).max(1000).default(1);
const limitSchema = z.coerce.number().int().min(1).max(100).default(20);
const slugSchema = z.string().max(120).regex(/^[a-z0-9-]+$/, "slug inválido");
const listIdSchema = z.string().uuid("Cabeçalho X-List-Id deve ser um UUID");

const methodology = {
  name: "Índice SteamTwo",
  formula: "100 × (N - posição + 1) / N",
  rules: [
    "Jogos presentes nas duas lojas recebem a média das notas disponíveis.",
    "Ausência em uma coleta válida vale zero; indisponibilidade da fonte é excluída.",
    "A semana representa a média dos sete snapshots diários válidos.",
    "De sempre é popularidade histórica, não uma contagem de horas jogadas.",
  ],
  sources: ["Steam Charts", "Epic Games Store — Mais jogados", "IGDB PopScore"],
};

/** Encapsula try/catch das rotas assíncronas (Express encaminha o erro ao handler central). */
const handle = (fn) => async (request, response, next) => {
  try {
    await fn(request, response);
  } catch (error) {
    next(error);
  }
};

export function createApiRouter({ catalogService = createCatalogService(), healthCheck } = {}) {
  const router = Router();
  const listId = (request) => listIdSchema.parse(request.get("x-list-id"));

  router.get("/health", async (_request, response, next) => {
    try {
      const database = healthCheck ? await healthCheck() : { status: "not-configured" };
      response.json({ status: "ok", mode: catalogService.mode, database, timestamp: new Date().toISOString() });
    } catch (error) {
      next(Object.assign(error, { status: 503, message: "Banco de dados indisponível" }));
    }
  });

  router.get("/status", handle(async (_request, response) => {
    response.json(await catalogService.status());
  }));

  router.get("/dashboard", handle(async (request, response) => {
    const { store } = z.object({ store: storeSchema }).parse(request.query);
    response.json(await catalogService.dashboard({ store }));
  }));

  router.get("/rankings", handle(async (request, response) => {
    const query = z.object({ period: periodSchema, store: storeSchema, page: pageSchema, limit: limitSchema }).parse(request.query);
    response.json(await catalogService.rankings(query));
  }));

  router.get("/games", handle(async (request, response) => {
    const query = z.object({
      q: z.string().max(100).default(""),
      genre: z.string().max(60).optional(),
      store: storeSchema,
      sort: z.enum(["popularity", "name"]).default("popularity"),
      page: pageSchema,
      limit: limitSchema.default(12),
    }).parse(request.query);
    response.json(await catalogService.games(query));
  }));

  router.get("/games/:slug", handle(async (request, response) => {
    const game = await catalogService.game(slugSchema.parse(request.params.slug));
    if (!game) return response.status(404).json({ error: "Jogo não encontrado" });
    return response.json(game);
  }));

  router.get("/genres", handle(async (_request, response) => {
    response.json({ items: await catalogService.genres() });
  }));

  // Lista pessoal ("Adicionar à lista"). Sem login: o navegador envia um UUID anônimo.
  router.get("/list", handle(async (request, response) => {
    response.json({ items: await catalogService.watchlist.list(listId(request)) });
  }));

  router.put("/list/:slug", handle(async (request, response) => {
    const result = await catalogService.watchlist.add(listId(request), slugSchema.parse(request.params.slug));
    response.status(result.added ? 201 : 200).json(result);
  }));

  router.delete("/list/:slug", handle(async (request, response) => {
    const result = await catalogService.watchlist.remove(listId(request), slugSchema.parse(request.params.slug));
    response.status(result.removed ? 200 : 404).json(result);
  }));

  router.get("/methodology", (_request, response) => response.json(methodology));

  router.use((_request, response) => response.status(404).json({ error: "Rota não encontrada" }));

  return router;
}
