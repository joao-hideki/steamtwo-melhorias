# Evidências de funcionamento

Geradas numa subida limpa (`docker compose down -v` e depois `docker compose up --build`) em 25/11/2026, com dados reais coletados da Steam e da Epic naquele momento. As capturas foram tiradas por script (Edge headless, 1440×900), clicando de verdade na interface.

| Arquivo | O que mostra |
|---|---|
| `01-inicio.png` | Destaque e índice lidos do banco (selo **PostgreSQL**). |
| `02-dashboard.png` | Última semana com filtro de loja, “de sempre” e recorde monitorado. |
| `03-rankings-agora.png`, `04-rankings-de-sempre.png`, `05-rankings-semana-epic.png` | Página Rankings (`/api/rankings`): períodos, filtro de loja e paginação. |
| `06-catalogo-filtro-rpg.png`, `07-catalogo-busca.png` | Filtro por gênero e busca feitos no SQL. |
| `08-detalhe-adicionado-lista.png`, `09-minha-lista.png` | “Adicionar à lista” gravando em `watchlist_items`. |
| `10-status-integracao.png`, `11-api-status-json.png` | Contagens das tabelas, frescor das fontes e `sync_runs`. |
| `log-docker-compose-sync.txt` | Saída dos serviços `migrate` e `sync` (migrações, seed, coleta e cálculo). |
| `log-testes-docker.txt` | `docker compose --profile test run --rm --build test`: 59 Vitest (15 com PostgreSQL) e 4 Sites. |