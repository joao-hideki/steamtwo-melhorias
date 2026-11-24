# Instruções para agentes

## Subir e verificar

- Subir tudo: `docker compose up --build` → http://localhost:3001 (API e interface na mesma porta).
  - Ordem dos serviços: `postgres` → `migrate` (migrações + seed, termina com código 0) → `api` e `sync`.
  - A API está pronta quando `GET /api/health` responder `"database":{"status":"connected"}`.
  - O `sync` busca dados reais na Steam e na Epic (precisa de internet). Primeiro ciclo: ~30 s. Acompanhe com `docker compose logs -f sync`.
- Testes sem Node local: `docker compose --profile test run --rm test` (47 Vitest + 4 Sites; 9 deles usam PostgreSQL real).
- Testes com Node 20+: `npm ci && npm run verify`. A integração com PostgreSQL usa `TEST_DATABASE_URL` ou `<DATABASE_URL>_test` do `.env`; sem nenhum dos dois, essa suíte é pulada com aviso.
- Evidência da integração: `GET /api/status` (contagens das tabelas, frescor das fontes, último `sync_run` de cada job) e a página `/status` da interface.
- O mapeamento rubrica → evidências está no `README.md`, seção “Como avaliar”.

## Convenções do código

- SQL sempre com placeholders (`$1`, `$2`…). Snapshots (`ranking_snapshots`/`ranking_entries`) são imutáveis por trigger: correções viram um novo snapshot.
- Escrita pelos jobs em `server/db/job-repository.js` (advisory lock + `sync_runs`). Leitura da API em `server/db/catalog-read-repository.js`.
- Sem `DATABASE_URL`, a API entra em modo demonstração (`mode: "demo"`) com `server/mock/games.js`.
- A interface fica em `src/` e só lê dados pela API (`src/api.js`).
- Nunca versionar `.env` ou credenciais (Twitch/IGDB são opcionais).

## Sites (herdado do projeto-base)

Mantenha `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs` e `tests/sites-worker.test.mjs` intactos. Antes de um handoff para Sites, rode `npm run build` e `npm run test:sites`. O build deve gerar `dist/client/index.html`, `dist/server/index.js` e `dist/.openai/hosting.json`.
