import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../server/app.js";
import { createApiRouter } from "../../server/routes/index.js";
import { createCatalogService } from "../../server/services/catalog-service.js";

const LIST_ID = "0b6f9f5e-2c4d-4d7a-9a51-6f0f1a2b3c4d";

function freshApp() {
  return createApp({ apiRouter: createApiRouter({ catalogService: createCatalogService() }) });
}

describe("lista pessoal (modo demonstração)", () => {
  it("adiciona, lista e remove jogos", async () => {
    const app = freshApp();
    await request(app).put("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(201);
    await request(app).put("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(200); // já estava
    const list = await request(app).get("/api/list").set("X-List-Id", LIST_ID).expect(200);
    expect(list.body.items.map((game) => game.slug)).toEqual(["portal-2"]);
    await request(app).delete("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(200);
    const empty = await request(app).get("/api/list").set("X-List-Id", LIST_ID).expect(200);
    expect(empty.body.items).toEqual([]);
  });

  it("listas de navegadores diferentes são independentes", async () => {
    const app = freshApp();
    await request(app).put("/api/list/portal-2").set("X-List-Id", LIST_ID).expect(201);
    const other = await request(app).get("/api/list").set("X-List-Id", "11111111-2222-4333-8444-555555555555").expect(200);
    expect(other.body.items).toEqual([]);
  });

  it("valida cabeçalho, slug e existência do jogo", async () => {
    const app = freshApp();
    const missingHeader = await request(app).get("/api/list").expect(400);
    expect(missingHeader.body.error).toBe("Parâmetros inválidos");
    await request(app).put("/api/list/Slug_Invalido").set("X-List-Id", LIST_ID).expect(400);
    await request(app).put("/api/list/nao-existe").set("X-List-Id", LIST_ID).expect(404);
  });
});

describe("validação e novas rotas", () => {
  it("explica o campo inválido em português", async () => {
    const response = await request(freshApp()).get("/api/games").query({ limit: 500 }).expect(400);
    expect(response.body.details[0]).toMatchObject({ campo: "limit", mensagem: expect.stringMatching(/^Muito grande/) });
    const period = await request(freshApp()).get("/api/rankings").query({ period: "ontem" }).expect(400);
    expect(period.body.details[0]).toMatchObject({ campo: "period", mensagem: expect.stringMatching(/^Opção inválida/) });
  });

  it("nomeia o cabeçalho e o slug inválidos no erro", async () => {
    const header = await request(freshApp()).get("/api/list").expect(400);
    expect(header.body.details[0].campo).toBe("X-List-Id");
    const slug = await request(freshApp()).put("/api/list/Slug_Invalido").set("X-List-Id", LIST_ID).expect(400);
    expect(slug.body.details[0]).toEqual({ campo: "slug", mensagem: "slug inválido" });
  });

  it("rota inexistente da API responde 404 em JSON", async () => {
    const response = await request(freshApp()).get("/api/nao-existe").expect(404);
    expect(response.body.error).toBe("Rota não encontrada");
  });

  it("lista gêneros com contagem e informa o modo no status", async () => {
    const app = freshApp();
    const genres = await request(app).get("/api/genres").expect(200);
    expect(genres.body.items.find((genre) => genre.name === "RPG").games).toBeGreaterThan(1);
    const status = await request(app).get("/api/status").expect(200);
    expect(status.body).toMatchObject({ mode: "demo", database: "not-configured" });
  });

  it("rankings paginam e respeitam o período", async () => {
    const response = await request(freshApp()).get("/api/rankings").query({ period: "all-time", limit: 3, page: 2 }).expect(200);
    expect(response.body.pagination).toMatchObject({ page: 2, limit: 3, total: 10, pages: 4 });
    expect(response.body.items[0].rank).toBe(4);
    expect(response.body.items[0].metric.type).toBe("popularity");
  });
});
