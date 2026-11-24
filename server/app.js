import express from "express";
import path from "node:path";

export function createApp({ apiRouter, staticDir } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  if (apiRouter) app.use("/api", apiRouter);

  if (staticDir) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) => {
      response.sendFile(path.resolve(staticDir, "index.html"));
    });
  }

  app.use((error, _request, response, _next) => {
    const isValidationError = error?.name === "ZodError";
    const isJsonError = error?.type === "entity.parse.failed";
    const status = Number(error.status ?? (isValidationError || isJsonError ? 400 : 500));
    // Erros inesperados vão para o log do servidor; o cliente recebe uma mensagem genérica.
    if (status >= 500 && status !== 503) console.error(error);
    response.status(status).json({
      error: status >= 500 && status !== 503
        ? "Erro interno do servidor"
        : isValidationError ? "Parâmetros inválidos" : error.message,
      ...(isValidationError ? { details: error.issues.map(({ path, message }) => ({ campo: path.join("."), mensagem: message })) } : {}),
    });
  });

  return app;
}
