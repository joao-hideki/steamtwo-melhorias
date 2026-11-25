"""Gera o relatório de auditoria de segurança do SteamTwo (HTML -> PDF via Edge headless).

Uso (a partir da raiz do repositório):
    py -3.13 -m venv docs/security-audit/.venv
    docs/security-audit/.venv/Scripts/python -m pip install -r docs/security-audit/requirements.txt
    docs/security-audit/.venv/Scripts/python docs/security-audit/gerar_relatorio.py [--preview DIR]

Saídas em docs/security-audit/:
    relatorio-auditoria-seguranca.html  (fonte intermediária)
    relatorio-auditoria-seguranca.pdf   (relatório final)
Com --preview DIR, cada página do PDF é rasterizada em PNG nesse diretório.

Os achados, pontos fortes e issues ficam nas estruturas de dados abaixo: edite-as e rode de novo.
"""
from __future__ import annotations

import argparse
import html
import io
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

HERE = Path(__file__).resolve().parent
HTML_OUT = HERE / "relatorio-auditoria-seguranca.html"
PDF_OUT = HERE / "relatorio-auditoria-seguranca.pdf"
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

PROJECT = "SteamTwo"
REPORT_TITLE = f"Relatório de Auditoria de Segurança — {PROJECT}"
REPORT_DATE = "24 de novembro de 2026"

# ----------------------------------------------------------------------------- paleta

SEV = {
    "crítica": {"color": "#B91C1C", "order": 0},
    "alta": {"color": "#EA580C", "order": 1},
    "média": {"color": "#D97706", "order": 2},
    "baixa": {"color": "#2563EB", "order": 3},
    "informativa": {"color": "#6B7280", "order": 4},
}
STRONG = "#059669"

CATEGORIES = {
    1: "Banco sem tranca (isolamento de dono)",
    2: "Permissão definida no navegador",
    3: "IDOR",
    4: "Chaves expostas (hardcode)",
    5: "Inputs sem tratamento (XSS)",
}
CAT_SHORT = {1: "1. Banco sem tranca", 2: "2. Permissão no navegador", 3: "3. IDOR", 4: "4. Chaves expostas", 5: "5. XSS"}

# ----------------------------------------------------------------------------- escopo e método

SCOPE = [
    ("Auditor", "João Hideki Takayasu — Tópicos Especiais em Informática (Fatec), Prof. David Silva"),
    ("Autorização", "SaaS de autoria e responsabilidade do próprio auditor (dono do repositório). Escopo restrito a esse "
                    "código e a instâncias locais com dados fictícios; nenhum sistema de terceiros foi testado."),
    ("Repositório", "<a href='https://github.com/joao-hideki/steamtwo-melhorias'>github.com/joao-hideki/steamtwo-melhorias</a> — "
                    "branch <code>main</code>, HEAD <code>4222366</code> (24/11/2026), 12 commits"),
    ("Projeto-base", "<code>fc96a53</code> “Initial SteamTwo project”, de outro autor; cada achado registra se já existia nele"),
    ("Código revisado", "server/ (API, repositórios, jobs, integrações), src/ (React), shared/, worker/, scripts/, migrations/, tests/"),
    ("Deploy e docs", "Dockerfile, docker-compose.yml, .github/workflows/ci.yml, .env.example, .gitignore, .dockerignore, vite.config.mjs, .openai/hosting.json, README.md, AGENTS.md, docs/evidencias"),
    ("Verificação dinâmica", "Cópia isolada do HEAD (git archive) no diretório temporário: build Vite do bundle, API em modo demo (porta 3901) e em modo banco (porta 3902) com PostgreSQL descartável em 127.0.0.1:55432. Só dados fictícios; tudo derrubado ao final."),
]

STACK = [
    ("Linguagem", "JavaScript (ES modules), Node 22"),
    ("Backend", "Express 5 + validação Zod 4"),
    ("Banco / acesso", "PostgreSQL 17 via <code>pg</code> (SQL manual com placeholders), migrações node-pg-migrate"),
    ("Autenticação", "Nenhuma. Não há login, sessão, JWT nem papéis. A “lista pessoal” usa um UUID anônimo gerado no navegador e enviado no cabeçalho <code>X-List-Id</code>"),
    ("Frontend", "React 19.2 + Vite 6 (SPA, roteamento por <code>history.pushState</code>)"),
    ("Deploy", "Docker (imagem única, usuário <code>node</code>), Docker Compose (postgres, migrate, api, sync, test), GitHub Actions; worker de Sites herdado do projeto-base. Sem Helm/Terraform"),
    ("Integrações", "Steam Web API e loja, Epic Store / egdata (scraping com cheerio), IGDB via OAuth client-credentials da Twitch (opcional)"),
]

METHOD = [
    (1, "Sem multi-tenant nem usuários: o único dado “de dono” é a tabela <code>watchlist_items</code>, isolada por filtro manual <code>list_id = $1</code>. Revisei todas as queries de listagem, contagem e agregação do repositório de leitura e do serviço demo para ver se cada uma filtra pelo <code>list_id</code> do chamador."),
    (2, "Sem papéis: procurei gates de papel no frontend (isAdmin, role, canEdit…) e qualquer operação privilegiada exposta por HTTP (jobs, seed, migrações, diagnóstico). A categoria clássica não se aplica; avaliei o único endpoint operacional (<code>/api/status</code>)."),
    (3, "Enumerei os 11 handlers de <code>server/routes/index.js</code> e segui cada um até a query. Objetos por ID: jogos por <code>slug</code> (catálogo público) e itens da lista por (<code>X-List-Id</code>, <code>slug</code>). Confirmei a posse com duas listas fictícias (A e B) nos dois modos."),
    (4, "Busca por padrões de segredo na árvore de trabalho, em todo o histórico git (<code>git log --all -p</code>), em compose/CI/.env.example/docs e no bundle gerado (<code>dist/client/assets</code>). Atenção a defaults <code>${VAR:-valor}</code> e à falta de validação de startup."),
    (5, "Busca por dangerouslySetInnerHTML, innerHTML, eval, new Function, markdown, href/src controlados por dados e CSS com <code>url()</code>; rastreio da origem de cada URL até o produtor; checagem de libs de sanitização e cabeçalhos HTTP de defesa (CSP etc.)."),
]

# ----------------------------------------------------------------------------- achados

FINDINGS = [
    {
        "id": "A1", "cat": 4, "sev": "média",
        "title": "Credenciais padrão do PostgreSQL (steamtwo/steamtwo) como fallback do compose “de produção”, sem validação de startup",
        "locs": [
            ("docker-compose.yml", "8", "NODE_ENV: production"),
            ("docker-compose.yml", "10", "DATABASE_URL: postgres://${POSTGRES_USER:-steamtwo}:${POSTGRES_PASSWORD:-steamtwo}@postgres:5432/${POSTGRES_DB:-steamtwo}"),
            ("docker-compose.yml", "20-22", "POSTGRES_DB: ${POSTGRES_DB:-steamtwo}\nPOSTGRES_USER: ${POSTGRES_USER:-steamtwo}\nPOSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-steamtwo}"),
            ("docker-compose.yml", "78", "TEST_DATABASE_URL: postgres://${POSTGRES_USER:-steamtwo}:${POSTGRES_PASSWORD:-steamtwo}@postgres:5432/steamtwo_test"),
            ("server/config.js", "6", 'databaseUrl: process.env.DATABASE_URL ?? "",'),
            ("server/index.js", "16-17", "if (config.databaseUrl) {\n  pool = createPool(config.databaseUrl);"),
        ],
        "why": "Se POSTGRES_PASSWORD não for definida, o compose sobe o banco e os serviços api/sync/migrate (com NODE_ENV=production) usando a senha pública “steamtwo”, que está no repositório. Nenhum ponto do código rejeita essa credencial: config.js só lê a variável e index.js conecta com o que vier. Quem alcançar a porta do banco ou a rede do compose entra como dono do banco (leitura e escrita de todas as tabelas, inclusive watchlist_items).",
        "cond": "Hoje a porta 5432 é publicada só em 127.0.0.1 (docker-compose.yml:25), então a exploração exige acesso ao host ou a outro container da mesma rede Docker. Vira acesso remoto direto se o compose for usado num servidor com a porta aberta ou se alguém remover o prefixo 127.0.0.1.",
        "origin": "Já existia no projeto-base: fc96a53 tinha POSTGRES_PASSWORD: steamtwo fixo e a porta \"5432:5432\" em todas as interfaces. 539d90c trocou por fallback ${POSTGRES_PASSWORD:-steamtwo} e adicionou NODE_ENV: production; de 539d90c a 5498fcb a porta seguiu publicada em todas as interfaces; 4222366 restringiu a 127.0.0.1.",
        "impact": "Comprometimento total do banco (confidencialidade e integridade) por quem alcançar a porta.",
    },
    {
        "id": "A2", "cat": 4, "sev": "baixa",
        "title": "A mesma credencial de desenvolvimento repetida em .env.example e no CI",
        "locs": [
            (".env.example", "4", "DATABASE_URL=postgres://steamtwo:steamtwo@localhost:5432/steamtwo"),
            (".github/workflows/ci.yml", "14-16", "POSTGRES_USER: steamtwo\nPOSTGRES_PASSWORD: steamtwo\nPOSTGRES_DB: steamtwo_test"),
            (".github/workflows/ci.yml", "23", "TEST_DATABASE_URL: postgres://steamtwo:steamtwo@localhost:5432/steamtwo_test"),
        ],
        "why": "Quem copia .env.example para .env (fluxo documentado) herda a senha pública; junto com A1, a credencial conhecida se espalha para todo ambiente criado a partir do exemplo. No CI o banco é um service container efêmero, sem dado real, então ali o risco é só de mau exemplo.",
        "cond": "Explorável apenas se o .env copiado for usado num banco alcançável por terceiros.",
        "origin": ".env.example: já existia no projeto-base (fc96a53, linha 3). CI: introduzido em 3ab80e7.",
        "impact": "Propagação de credencial conhecida para ambientes locais e de homologação.",
    },
    {
        "id": "A3", "cat": 1, "sev": "baixa",
        "title": "Agregação global de watchlist_items sem filtro de dono, exposta a qualquer visitante em GET /api/status",
        "locs": [
            ("server/db/catalog-read-repository.js", "200-204", 'pool.query(`SELECT (SELECT count(*) FROM games)::int AS games,\n  ...\n  (SELECT count(*) FROM watchlist_items)::int AS "watchlistItems"`),'),
            ("server/routes/index.js", "55-57", 'router.get("/status", handle(async (_request, response) => {\n  response.json(await catalogService.status());\n}));'),
            ("src/App.jsx", "510", 'watchlistItems: "Itens em listas"'),
        ],
        "why": "É a única consulta sobre watchlist_items que não filtra por list_id: soma os itens de todas as listas anônimas e devolve o total sem autenticação. Verificado localmente: com itens só na lista A, um cliente sem cabeçalho recebeu \"watchlistItems\": 2. Não vaza o conteúdo de nenhuma lista, só o volume agregado de uso de todos os usuários.",
        "cond": "Sempre (endpoint público, modo banco).",
        "origin": "Introduzido depois do projeto-base (888c522, junto com a lista pessoal e /api/status).",
        "impact": "Vazamento de métrica agregada de uso; permite acompanhar a atividade de todos os usuários ao longo do tempo.",
    },
    {
        "id": "A4", "cat": 2, "sev": "baixa",
        "title": "Endpoint de diagnóstico /api/status é público e devolve mensagens de erro internas dos jobs",
        "locs": [
            ("server/db/catalog-read-repository.js", "205-206", 'pool.query(`SELECT DISTINCT ON (job) job, state, started_at AS "startedAt", finished_at AS "finishedAt",\n  details, error_message AS error FROM sync_runs ORDER BY job, started_at DESC`),'),
            ("server/jobs/run-job.js", "2, 28", "return error instanceof Error ? error.message : String(error);\n...\nerror: serializeError(error),"),
            ("server/routes/index.js", "55-57", 'router.get("/status", handle(async (_request, response) => { ... }));'),
            ("src/App.jsx", "538", '<span role="cell">{run.error ?? formatNumber(run.details?.records)}</span>'),
        ],
        "why": "O handler central de erros (server/app.js:18-31) esconde detalhes de 5xx, mas /api/status contorna isso: a mensagem crua de qualquer exceção de job (PostgreSQL, HTTP das fontes externas) é gravada em sync_runs.error_message e devolvida a qualquer visitante, sem verificação de privilégio. Teste local com dado fictício: um run falho com 'duplicate key value violates unique constraint \"ranking_snapshots_source_captured_at_key\"' apareceu na resposta anônima. A interface também mostra a página /status para todos (não há gate no frontend nem no backend).",
        "cond": "Sempre que algum job falhar (modo banco). O conteúdo vazado depende da exceção.",
        "origin": "Introduzido depois do projeto-base (888c522). O projeto-base não tinha /api/status.",
        "impact": "Divulgação de nomes de tabelas e constraints, estado operacional e falhas de integração; ajuda no reconhecimento para outros ataques.",
    },
    {
        "id": "A5", "cat": 5, "sev": "baixa",
        "title": "Sem cabeçalhos HTTP de defesa (Content-Security-Policy, frame-ancestors/X-Frame-Options, X-Content-Type-Options)",
        "locs": [
            ("server/app.js", "4-16", 'const app = express();\napp.disable("x-powered-by");\napp.use(express.json({ limit: "256kb" }));\n...\napp.use(express.static(staticDir));'),
        ],
        "why": "Nenhum middleware define CSP ou anti-framing; confirmado com curl -I na API local (GET / e /api/*). Hoje não há XSS explorável (seção de pontos fortes), mas qualquer XSS futuro roda sem segunda barreira e pode ler o X-List-Id do localStorage. Sem frame-ancestors, a página pode ser embutida em iframe de terceiros (clickjacking sobre “Adicionar à lista”, de impacto baixo).",
        "cond": "Exige uma segunda falha (XSS) ou interação da vítima com a página do atacante para clickjacking.",
        "origin": "Já existia no projeto-base (server/app.js de fc96a53 é igual nesse ponto).",
        "impact": "Defesa em profundidade ausente; amplia o impacto de falhas futuras.",
    },
    {
        "id": "A6", "cat": 5, "sev": "informativa",
        "title": "URLs de loja vindas do banco vão direto para href, sem allowlist de esquema/domínio",
        "locs": [
            ("src/format.js", "25", "if (listing?.url) return listing.url;"),
            ("src/App.jsx", "433", '<a className="primary-button" key={store} href={storeUrl(game, store)} target="_blank" rel="noreferrer">'),
            ("server/db/job-repository.js", "10", "if (suppliedUrl) return suppliedUrl;"),
        ],
        "why": "O valor de store_listings.url é repassado ao href sem validação. Não é explorável hoje: todos os produtores montam https:// fixo (steam-store-client.js:36, normalizers.js:62, job-repository.js:11-16 e o seed), e o React 19.2 bloqueia URLs javascript: (o bundle gerado contém a proteção “React has blocked a javascript: URL”). Fica registrado porque a garantia depende de cada fonte futura e não existe uma validação central.",
        "cond": "Só se uma fonte nova, um scraping alterado ou uma escrita manual gravar URL com esquema perigoso, ou apontar para domínio de phishing.",
        "origin": "Repasse no servidor (job-repository.js) já existia no projeto-base; uso de listing.url no frontend introduzido em d4b1d47.",
        "impact": "Hoje nenhum; no futuro, link de loja apontando para domínio arbitrário.",
    },
    {
        "id": "A7", "cat": 3, "sev": "informativa",
        "title": "A posse da lista é só o UUID enviado pelo cliente (bearer), sem segredo emitido pelo servidor",
        "locs": [
            ("server/routes/index.js", "13", 'const listIdSchema = z.string().uuid("Cabeçalho X-List-Id deve ser um UUID");'),
            ("server/routes/index.js", "43", 'const listId = (request) => z.object({ "X-List-Id": listIdSchema }).parse({ "X-List-Id": request.get("x-list-id") })["X-List-Id"];'),
            ("src/api.js", "34-48", 'let id = window.localStorage.getItem(LIST_KEY);\n... id = crypto.randomUUID(); ...\nconst listHeaders = () => ({ "X-List-Id": getListId() });'),
        ],
        "why": "As rotas de lista estão corretas contra IDOR clássico: toda query filtra por list_id, e o teste local confirmou que a lista B não lê nem apaga itens da lista A (GET vazio, DELETE 404). Mas o identificador é escolhido pelo cliente, não expira e não pode ser revogado: quem souber o UUID lê e altera a lista. O servidor aceita qualquer UUID válido, inclusive o nulo 00000000-0000-0000-0000-000000000000 (testado: 200), que vira uma lista compartilhada por todos que o usarem.",
        "cond": "Exige que o UUID da vítima vaze (logs de proxy que gravam cabeçalhos, XSS, máquina compartilhada). Adivinhar é inviável: o frontend gera 122 bits aleatórios com crypto.randomUUID.",
        "origin": "Introduzido depois do projeto-base (888c522 API, d4b1d47 frontend).",
        "impact": "Baixo: dados da lista são preferências públicas de jogos, sem PII.",
    },
]

# ----------------------------------------------------------------------------- pontos fortes

STRENGTHS = [
    (1, "Toda query da lista pessoal filtra pelo dono",
     "server/db/catalog-read-repository.js:218 (list), :222 (count), :235-243 (add, com pg_advisory_xact_lock por lista), :249 (remove, DELETE … WHERE w.list_id = $1 AND g.slug = $2). Modo demo: server/services/catalog-service.js:123-142 indexa o Map por listId."),
    (1, "Isolamento confirmado em execução",
     "Modos demo e banco: lista A com 2 jogos; lista B recebeu {\"items\":[]} no GET e 404 {\"removed\":false} no DELETE; a lista A ficou intacta."),
    (2, "Não há operação privilegiada exposta por HTTP",
     "Jobs de sincronização, seed e migrações só rodam por CLI (server/jobs/cli.js, server/db/seed-cli.js, npx node-pg-migrate). O router (server/routes/index.js:46-108) só tem GETs públicos e PUT/DELETE da própria lista."),
    (2, "Frontend sem gate de papel que dependa do servidor",
     "Nenhum isAdmin/role/canEdit em src/ (as ocorrências de “role” em App.jsx são atributos ARIA). Nada é escondido só no navegador."),
    (3, "Os 11 handlers foram percorridos; parâmetros de ID validados",
     "slug: regex ^[a-z0-9-]+$ e máx. 120 (routes/index.js:12); X-List-Id: UUID (routes/index.js:13); jogos são catálogo público por desenho; itens da lista usam a chave composta (list_id, game_id) (migrations/002, PK)."),
    (3, "Sem CSRF nas escritas da lista",
     "PUT/DELETE exigem o cabeçalho customizado X-List-Id e não há middleware CORS: o preflight de outra origem recebe 404 sem Access-Control-Allow-Origin (testado), então um site de terceiros não consegue disparar a escrita."),
    (4, "Segredos lidos do ambiente e fora do controle de versão",
     "server/config.js:3-11 lê TWITCH_CLIENT_ID/SECRET e DATABASE_URL de process.env; .env está em .gitignore:3 e .dockerignore:3; TWITCH_* no compose têm default vazio (docker-compose.yml:13-14)."),
    (4, "Histórico git sem segredos reais",
     "git log --all -p nos 12 commits: só a senha de desenvolvimento “steamtwo” (A1/A2) e valores fictícios de teste (tests/fixtures/igdb-token.json: \"fixture-token\"; clients.test.js: clientSecret \"secret\")."),
    (4, "Bundle do frontend sem chaves",
     "Build local do HEAD: dist/client/assets/index-*.js não contém URLs de banco, tokens nem client_secret; o código não usa import.meta.env/VITE_*. A única ocorrência de “TWITCH_CLIENT_ID” é o texto de ajuda da página /status."),
    (4, "Banco publicado só no loopback",
     "docker-compose.yml:25 \"127.0.0.1:${POSTGRES_PORT:-5432}:5432\" (desde 4222366) reduz a exposição de A1."),
    (5, "Nenhuma injeção de HTML no frontend",
     "Sem dangerouslySetInnerHTML, innerHTML, eval, new Function, markdown ou v-html em src/; todo texto (título, resumo, gêneros, erros de job) é renderizado como texto escapado pelo React. As ocorrências de innerHTML no bundle são internas do react-dom."),
    (5, "URLs de imagem e de loja com origem controlada",
     "coverUrl/heroUrl vêm de CDNs fixos ou do header_image da API da Steam (steam-store-client.js:5, 33); da IGDB só passa URL que casa com ^https?:// (normalizers.js:14-18); React 19.2 bloqueia javascript: em href/src (confirmado no bundle); links externos usam rel=\"noreferrer\" (App.jsx:433); slugs nas URLs passam por encodeURIComponent (App.jsx:415, 615; api.js:52-53)."),
    (5, "Backend só responde JSON e esconde erros 5xx",
     "server/app.js:18-31 devolve “Erro interno do servidor” em 5xx e loga o detalhe no servidor; não há e-mails nem templates HTML; a descrição da Steam passa por stripHtml (steam-store-client.js:7-10) antes de ir ao banco."),
    (0, "SQL sempre parametrizado",
     "Todas as queries usam $1, $2…; a busca escapa curingas do LIKE (catalog-read-repository.js:64-66). Teste local: q=' OR 1=1-- devolveu 0 itens; slug com aspas retornou 400."),
    (0, "Validação de entrada com Zod em todas as rotas",
     "Enums para store/period/sort, limites de page/limit, texto livre com tamanho máximo e sem byte nulo (routes/index.js:8-16); corpo JSON limitado a 256 kB (app.js:7); x-powered-by desligado (app.js:6)."),
    (0, "Container sem root",
     "Dockerfile:14 instala só dependências de produção; Dockerfile:19 USER node."),
]

# ----------------------------------------------------------------------------- recomendações

RECOMMENDATIONS = [
    ("P1", "média", ["A1", "A2"], "Eliminar a credencial padrão do banco",
     "Trocar <code>${POSTGRES_PASSWORD:-steamtwo}</code> por <code>${POSTGRES_PASSWORD:?defina POSTGRES_PASSWORD no .env}</code> (o mesmo para usuário/banco, se quiser) e validar no startup (server/config.js) que, com NODE_ENV=production, DATABASE_URL existe e não usa a senha “steamtwo”. No .env.example, deixar a senha como placeholder. Manter a porta do banco em 127.0.0.1."),
    ("P2", "baixa", ["A4", "A3"], "Fechar o vazamento do /api/status",
     "Gravar em sync_runs uma mensagem genérica/código de erro (o detalhe vai para o log), ou devolver <code>error</code> apenas a operadores autenticados (token de operação via variável de ambiente). Remover o total global de watchlist_items da resposta pública ou movê-lo para o endpoint restrito."),
    ("P2", "baixa", ["A5"], "Adicionar cabeçalhos de segurança",
     "Usar helmet (ou cabeçalhos manuais) com CSP <code>default-src 'self'; img-src 'self' https://cdn.cloudflare.steamstatic.com https://shared.cloudflare.steamstatic.com https://images.igdb.com https://images.unsplash.com; frame-ancestors 'none'</code>, além de X-Content-Type-Options: nosniff e Referrer-Policy."),
    ("P3", "informativa", ["A6"], "Validar URLs de loja num ponto central",
     "Aceitar só https:// e os domínios store.steampowered.com e store.epicgames.com em storeUrl (job-repository.js) e de novo em src/format.js antes de renderizar; o resto cai para a URL de busca."),
    ("P3", "informativa", ["A7"], "Endurecer a identidade anônima da lista",
     "Rejeitar UUIDs que não sejam v4 (inclusive o nulo), avaliar um identificador emitido pelo servidor em cookie HttpOnly/SameSite, e aplicar rate limit nas rotas de escrita."),
    ("P3", "—", [], "Fora das cinco categorias: dependências",
     "<code>npm audit --omit=dev</code> no HEAD aponta 16 avisos (1 crítico, 11 altos, 4 moderados), incluindo diretos em zod, vite e node-pg-migrate. Não foram verificados um a um e não entram na contagem de achados; rodar <code>npm audit fix</code> e reexecutar os testes."),
]

# ----------------------------------------------------------------------------- cobertura de rotas (IDOR)

ROUTES = [
    ("GET", "/api/health", "46", "—", "Sem objeto; só status do banco", "OK"),
    ("GET", "/api/status", "55", "—", "Agregados globais e sync_runs, sem controle de acesso", "A3, A4"),
    ("GET", "/api/dashboard", "59", "store (enum)", "Catálogo público", "OK"),
    ("GET", "/api/rankings", "64", "period/store (enum), page/limit", "Catálogo público", "OK"),
    ("GET", "/api/games", "69", "q, genre, store, sort", "Catálogo público; SQL parametrizado", "OK"),
    ("GET", "/api/games/:slug", "81", "slug (regex)", "Catálogo público por desenho", "OK"),
    ("GET", "/api/genres", "87", "—", "Catálogo público", "OK"),
    ("GET", "/api/list", "92", "X-List-Id (UUID)", "WHERE w.list_id = $1", "OK (A7 informativo)"),
    ("PUT", "/api/list/:slug", "96", "X-List-Id + slug", "Insere com o list_id do chamador", "OK (A7 informativo)"),
    ("DELETE", "/api/list/:slug", "101", "X-List-Id + slug", "WHERE list_id = $1 AND slug = $2", "OK (A7 informativo)"),
    ("GET", "/api/methodology", "106", "—", "Conteúdo estático", "OK"),
]

# ----------------------------------------------------------------------------- issues

ISSUES = [
    {
        "title": "[Segurança] Credencial padrão do PostgreSQL (steamtwo) usada como fallback e sem validação no startup",
        "labels": "security, severidade:média",
        "findings": "A1, A2",
        "body": """## Descrição
O `docker-compose.yml` usa `${POSTGRES_PASSWORD:-steamtwo}` (e o mesmo para usuário e banco). Se a variável não for definida, o banco e os serviços `api`, `sync` e `migrate` sobem com `NODE_ENV: production` e a senha pública `steamtwo`, que está no repositório. Nada no código rejeita essa credencial: `server/config.js` só lê `DATABASE_URL` e `server/index.js` conecta com o que vier. O `.env.example` e o CI repetem a mesma senha, o que espalha a credencial conhecida para qualquer `.env` copiado do exemplo.

Hoje a porta do banco é publicada só em `127.0.0.1`, então a exploração exige acesso ao host ou à rede do compose. Basta usar o compose num servidor com a porta aberta (ou remover o prefixo `127.0.0.1`) para virar acesso remoto direto. Entre os commits 539d90c e 5498fcb a porta esteve publicada em todas as interfaces com essa senha; no projeto-base (fc96a53) a senha era fixa e a porta também ficava aberta.

## Evidência
- `docker-compose.yml:8` — `NODE_ENV: production`
- `docker-compose.yml:10` — `DATABASE_URL: postgres://${POSTGRES_USER:-steamtwo}:${POSTGRES_PASSWORD:-steamtwo}@postgres:5432/${POSTGRES_DB:-steamtwo}`
- `docker-compose.yml:20-22` — `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-steamtwo}`
- `docker-compose.yml:78` — `TEST_DATABASE_URL: postgres://${POSTGRES_USER:-steamtwo}:${POSTGRES_PASSWORD:-steamtwo}@...`
- `server/config.js:6` — `databaseUrl: process.env.DATABASE_URL ?? "",` (sem validação)
- `.env.example:4` — `DATABASE_URL=postgres://steamtwo:steamtwo@localhost:5432/steamtwo`
- `.github/workflows/ci.yml:15,23` — `POSTGRES_PASSWORD: steamtwo` (container efêmero de CI, só referência)

## Impacto
Quem alcançar a porta 5432 ou a rede do compose tem acesso total ao banco: lê e altera catálogo, rankings, `sync_runs` e todas as listas pessoais.

## Sugestão de correção
1. No compose, trocar os defaults por variáveis obrigatórias: `${POSTGRES_PASSWORD:?defina POSTGRES_PASSWORD no .env}` (idem em `DATABASE_URL` e `TEST_DATABASE_URL`).
2. Em `server/config.js`, validar no startup: com `NODE_ENV=production`, exigir `DATABASE_URL` e abortar se a senha for `steamtwo` ou estiver vazia.
3. No `.env.example`, usar um placeholder (`DATABASE_URL=postgres://steamtwo:<troque-esta-senha>@localhost:5432/steamtwo`) e documentar no README a geração de uma senha.
4. Manter a publicação da porta do banco em `127.0.0.1`.

## Critérios de aceite
- [ ] `docker compose up` sem `POSTGRES_PASSWORD` definido falha com mensagem clara.
- [ ] Nenhum `${...:-steamtwo}` restante em `docker-compose.yml` (`grep -n ':-steamtwo' docker-compose.yml` vazio).
- [ ] A API com `NODE_ENV=production` e senha `steamtwo` encerra no startup com erro explícito (teste automatizado).
- [ ] `.env.example` não contém senha utilizável.
- [ ] README atualizado com o passo de definir a senha.
""",
    },
    {
        "title": "[Segurança] /api/status público expõe mensagens de erro internas e o total global das listas",
        "labels": "security, severidade:baixa",
        "findings": "A4, A3",
        "body": """## Descrição
`GET /api/status` não tem nenhum controle de acesso e devolve:
1. `sync_runs.error_message` de cada job, que é a mensagem crua da exceção (`error.message`) gravada por `server/jobs/run-job.js`. Erros do PostgreSQL e das fontes externas chegam assim a qualquer visitante, contornando o handler central que esconde detalhes de 5xx.
2. `count(*) FROM watchlist_items` sem filtro de dono: o total de itens de todas as listas anônimas.

Verificado localmente com dados fictícios: um run falho com `duplicate key value violates unique constraint "ranking_snapshots_source_captured_at_key"` apareceu na resposta anônima, e `watchlistItems` refletiu itens de outra lista.

## Evidência
- `server/routes/index.js:55-57` — `router.get("/status", ...)` sem verificação
- `server/db/catalog-read-repository.js:205-206` — `details, error_message AS error FROM sync_runs`
- `server/db/catalog-read-repository.js:204` — `(SELECT count(*) FROM watchlist_items)::int AS "watchlistItems"`
- `server/jobs/run-job.js:2` — `return error instanceof Error ? error.message : String(error);`
- `src/App.jsx:538` — `{run.error ?? formatNumber(run.details?.records)}` (exibido a todos)

## Impacto
Divulgação de nomes de tabelas/constraints, falhas de integração e métrica agregada de uso de todos os usuários. Ajuda no reconhecimento; não expõe o conteúdo de listas.

## Sugestão de correção
- Gravar em `sync_runs` um código/mensagem genérica (ex.: `falha na fonte steam`, `erro de banco`) e mandar o detalhe só para o log do processo.
- Ou separar: `/api/status` público com frescor das fontes e contagens do catálogo; detalhes de jobs e `watchlistItems` em rota restrita (token de operação em variável de ambiente, comparação em tempo constante).
- Ajustar a página `/status` da interface ao novo contrato.

## Critérios de aceite
- [ ] Resposta anônima de `/api/status` não contém texto de exceção (teste com run falho fictício).
- [ ] Resposta anônima não contém `watchlistItems` (ou a rota restrita exige token e responde 401 sem ele).
- [ ] O detalhe do erro continua disponível no log do serviço `sync`.
- [ ] Testes de API cobrindo os dois casos.
""",
    },
    {
        "title": "[Segurança] Adicionar cabeçalhos HTTP de segurança (CSP, frame-ancestors, nosniff) e validar URLs de loja",
        "labels": "security, severidade:baixa",
        "findings": "A5, A6",
        "body": """## Descrição
O Express não define Content-Security-Policy, proteção contra framing nem `X-Content-Type-Options` (confirmado com `curl -I` em `/` e `/api/*`). Hoje não há XSS explorável, mas qualquer falha futura rodaria sem segunda barreira e poderia ler o `X-List-Id` do `localStorage`; sem `frame-ancestors`, a interface pode ser embutida por terceiros (clickjacking).

Junto disso, a URL de loja vinda do banco vai direto para o `href`, sem allowlist. Não é explorável hoje: todos os produtores montam `https://` fixo e o React 19.2 bloqueia `javascript:`. A garantia, porém, depende de cada fonte futura.

## Evidência
- `server/app.js:4-16` — `express()`, `express.json`, `express.static` sem middleware de cabeçalhos
- `src/format.js:25` — `if (listing?.url) return listing.url;`
- `src/App.jsx:433` — `<a ... href={storeUrl(game, store)} target="_blank" rel="noreferrer">`
- `server/db/job-repository.js:10` — `if (suppliedUrl) return suppliedUrl;`

## Impacto
Defesa em profundidade ausente; amplia o impacto de uma eventual falha de XSS ou de uma fonte de dados comprometida.

## Sugestão de correção
- Adicionar `helmet` (ou cabeçalhos manuais) com CSP compatível com as imagens usadas:
  `default-src 'self'; img-src 'self' https://cdn.cloudflare.steamstatic.com https://shared.cloudflare.steamstatic.com https://images.igdb.com https://images.unsplash.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`
- `X-Content-Type-Options: nosniff` e `Referrer-Policy: strict-origin-when-cross-origin`.
- Validar URL de loja em `storeUrl` (servidor) e em `src/format.js`: só `https:` e hosts `store.steampowered.com` / `store.epicgames.com`; caso contrário, usar a URL de busca.

## Critérios de aceite
- [ ] `curl -I http://localhost:3001/` mostra `Content-Security-Policy` com `frame-ancestors 'none'` e `X-Content-Type-Options: nosniff`.
- [ ] A interface funciona sem violações de CSP no console (dashboard, catálogo, detalhe, lista, status).
- [ ] Teste unitário: `storeUrl` com `javascript:alert(1)` ou `https://evil.example` devolve a URL de busca da loja.
- [ ] Teste de API verificando a presença dos cabeçalhos.
""",
    },
    {
        "title": "[Segurança] Endurecer o identificador anônimo da lista (X-List-Id)",
        "labels": "security, severidade:informativa",
        "findings": "A7",
        "body": """## Descrição
A posse da lista pessoal é só o UUID que o navegador envia em `X-List-Id`. As rotas filtram corretamente por esse valor (sem IDOR clássico: a lista B não lê nem apaga itens da lista A, verificado localmente), mas o identificador é escolhido pelo cliente, não expira e não pode ser revogado. O servidor aceita qualquer UUID sintaticamente válido, inclusive o nulo `00000000-0000-0000-0000-000000000000`, que vira uma lista compartilhada. Também não há limite de criação de listas nem rate limit nas escritas.

## Evidência
- `server/routes/index.js:13` — `z.string().uuid(...)` aceita qualquer versão, inclusive o UUID nulo
- `server/routes/index.js:43` — o `list_id` vem direto do cabeçalho
- `src/api.js:34-48` — UUID gerado com `crypto.randomUUID()` e guardado no `localStorage`

## Impacto
Baixo: quem obtiver o UUID (log de proxy que grave cabeçalhos, máquina compartilhada, XSS futuro) lê e altera a lista, que só contém preferências públicas de jogos. Adivinhar um UUID v4 aleatório é inviável.

## Sugestão de correção
- Aceitar apenas UUID v4 (`z.uuid({ version: "v4" })` no Zod 4) e rejeitar o UUID nulo.
- Avaliar emitir o identificador no servidor, em cookie `HttpOnly; Secure; SameSite=Lax`, em vez de deixá-lo no `localStorage`.
- Aplicar rate limit em `PUT/DELETE /api/list/:slug`.

## Critérios de aceite
- [ ] `GET /api/list` com `X-List-Id: 00000000-0000-0000-0000-000000000000` responde 400.
- [ ] UUIDs de versões diferentes de 4 são rejeitados (teste de API).
- [ ] Escritas acima do limite configurado por IP/minuto recebem 429.
""",
    },
]

OUT_OF_SCOPE = [
    "npm audit --omit=dev no HEAD: 16 avisos (1 crítico em proxy-addr, que só importa com trust proxy, não configurado; altos diretos em zod e vite). Não verificados individualmente e fora da contagem.",
    "Sem rate limit; no modo demonstração as listas ficam num Map em memória sem limite de quantidade de listas (server/services/catalog-service.js:40, 134).",
    "vite.config.mjs:12 sobe o servidor de desenvolvimento em 0.0.0.0 (só em npm run dev).",
]

# ----------------------------------------------------------------------------- gráficos


def _svg(fig) -> str:
    buffer = io.StringIO()
    fig.savefig(buffer, format="svg", bbox_inches="tight", transparent=True)
    plt.close(fig)
    text = buffer.getvalue()
    return text[text.index("<svg"):]


def _setup_matplotlib():
    plt.rcParams.update({
        "svg.fonttype": "none",
        "font.family": ["Segoe UI", "DejaVu Sans"],
        "font.size": 10,
        "axes.edgecolor": "#D1D5DB",
        "axes.labelcolor": "#374151",
        "xtick.color": "#4B5563",
        "ytick.color": "#374151",
    })


def donut_chart(counts: dict[str, int]) -> str:
    labels = [s for s in SEV if counts[s] > 0]
    values = [counts[s] for s in labels]
    colors = [SEV[s]["color"] for s in labels]
    fig, ax = plt.subplots(figsize=(3.4, 3.4))
    wedges, _ = ax.pie(values, colors=colors, startangle=90, counterclock=False,
                       wedgeprops={"width": 0.36, "edgecolor": "white", "linewidth": 2.5})
    for wedge, value in zip(wedges, values):
        import math
        angle = math.radians((wedge.theta1 + wedge.theta2) / 2)
        r = 0.82
        ax.text(r * math.cos(angle), r * math.sin(angle), str(value), ha="center", va="center",
                color="white", fontsize=12, fontweight="bold")
    total = sum(values)
    ax.text(0, 0.08, str(total), ha="center", va="center", fontsize=28, fontweight="bold", color="#111827")
    ax.text(0, -0.22, "achados", ha="center", va="center", fontsize=10, color="#6B7280")
    ax.set_aspect("equal")
    return _svg(fig)


def bar_chart() -> str:
    cats = list(CATEGORIES)
    fig, ax = plt.subplots(figsize=(4.9, 3.0))
    y_find = [c - 0.19 for c in cats]
    y_strong = [c + 0.19 for c in cats]
    left = [0] * len(cats)
    for sev in SEV:
        widths = [sum(1 for f in FINDINGS if f["cat"] == c and f["sev"] == sev) for c in cats]
        if not any(widths):
            continue
        ax.barh(y_find, widths, left=left, height=0.36, color=SEV[sev]["color"], label=f"Achado {sev}",
                edgecolor="white", linewidth=1.2)
        left = [a + b for a, b in zip(left, widths)]
    strong = [sum(1 for s in STRENGTHS if s[0] == c) for c in cats]
    ax.barh(y_strong, strong, height=0.36, color=STRONG, label="Ponto forte", edgecolor="white", linewidth=1.2)
    for y, v in zip(y_find, left):
        ax.text(v + 0.06, y, str(v), va="center", fontsize=9, color="#111827")
    for y, v in zip(y_strong, strong):
        ax.text(v + 0.06, y, str(v), va="center", fontsize=9, color=STRONG)
    ax.set_yticks(cats)
    ax.set_yticklabels([CAT_SHORT[c] for c in cats])
    ax.invert_yaxis()
    ax.set_xlim(0, max(max(left), max(strong)) + 0.8)
    ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(integer=True))
    ax.set_xlabel("quantidade")
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.grid(axis="x", color="#E5E7EB", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.legend(loc="upper center", bbox_to_anchor=(0.4, -0.2), ncol=2, frameon=False, fontsize=9)
    return _svg(fig)


# ----------------------------------------------------------------------------- HTML

e = html.escape


def chip(sev: str) -> str:
    color = SEV[sev]["color"] if sev in SEV else "#9CA3AF"
    return f'<span class="chip" style="background:{color}">{e(sev)}</span>'


def loc_text(f) -> str:
    return "<br>".join(f"<code>{e(path)}:{e(lines)}</code>" for path, lines, _ in f["locs"])


CSS = """
@page {
  size: A4;
  margin: 2cm 2cm 2cm 2cm;
  @top-left { content: "Relatório de Auditoria de Segurança — SteamTwo"; font: 8pt 'Segoe UI', sans-serif; color: #6B7280; vertical-align: bottom; padding-bottom: 4mm; }
  @top-right { content: "Confidencial · uso interno"; font: 8pt 'Segoe UI', sans-serif; color: #9CA3AF; vertical-align: bottom; padding-bottom: 4mm; }
  @bottom-left { content: "SteamTwo · auditoria de 24/11/2026"; font: 8pt 'Segoe UI', sans-serif; color: #9CA3AF; vertical-align: top; padding-top: 4mm; }
  @bottom-right { content: "Página " counter(page) " de " counter(pages); font: 8pt 'Segoe UI', sans-serif; color: #6B7280; vertical-align: top; padding-top: 4mm; }
}
@page :first {
  @top-left { content: none; } @top-right { content: none; }
  @bottom-left { content: none; } @bottom-right { content: none; }
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; font-size: 9.6pt; line-height: 1.5; color: #1F2937; margin: 0; background: #fff; }
h1, h2, h3, h4 { color: #111827; line-height: 1.25; break-after: avoid; }
h2 { font-size: 16pt; margin: 0 0 10px; padding-bottom: 6px; border-bottom: 2px solid #111827; }
h3 { font-size: 11.5pt; margin: 18px 0 8px; }
h4 { font-size: 10pt; margin: 10px 0 4px; }
p { margin: 0 0 8px; }
code { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 8.4pt; background: #F3F4F6; padding: 0 3px; border-radius: 3px; word-break: break-word; }
.section { break-before: page; }
.muted { color: #6B7280; }
.small { font-size: 8.6pt; }

/* capa */
.cover { }
.cover .band { background: #111827; color: #fff; padding: 28px 30px 26px; border-radius: 6px; }
.cover .kicker { font-size: 9pt; letter-spacing: .14em; text-transform: uppercase; color: #9CA3AF; margin-bottom: 10px; }
.cover h1 { color: #fff; font-size: 25pt; margin: 0 0 8px; }
.cover .date { color: #D1D5DB; font-size: 11pt; }
.cover .sevbar { display: flex; height: 8px; margin-top: 18px; border-radius: 4px; overflow: hidden; }
.cover .sevbar span { flex: 1; }
.kv { width: 100%; border-collapse: collapse; margin-top: 4px; }
.kv th { text-align: left; vertical-align: top; width: 27%; padding: 5px 10px 5px 0; color: #374151; font-weight: 600; border-bottom: 1px solid #E5E7EB; }
.kv td { padding: 5px 0; border-bottom: 1px solid #E5E7EB; }
.cover h3 { margin-top: 18px; }
.method { width: 100%; border-collapse: collapse; }
.method td { padding: 5px 8px; vertical-align: top; border-bottom: 1px solid #E5E7EB; font-size: 8.6pt; }
.method td:first-child { width: 31%; font-weight: 600; color: #111827; }

/* resumo */
.kpis { display: flex; gap: 8px; margin: 10px 0 14px; }
.kpi { flex: 1; border: 1px solid #E5E7EB; border-top: 5px solid; border-radius: 6px; padding: 8px 10px; }
.kpi b { display: block; font-size: 20pt; line-height: 1.1; color: #111827; }
.kpi span { font-size: 8.4pt; color: #4B5563; }
.charts { display: flex; gap: 14px; align-items: center; margin: 4px 0 10px; }
.chart-box { border: 1px solid #E5E7EB; border-radius: 6px; padding: 8px 10px; }
.chart-box h4 { margin: 0 0 2px; }
.chart-box svg { width: 100%; height: auto; display: block; }
.donut { flex: 0 0 34%; }
.bars { flex: 1; }
.legend { list-style: none; padding: 0; margin: 4px 0 0; font-size: 8.4pt; }
.legend li { display: flex; align-items: center; gap: 6px; margin: 1px 0; }
.legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.callout { border-left: 4px solid #111827; background: #F9FAFB; padding: 8px 12px; margin: 8px 0; }

/* chips e tabelas */
.chip { display: inline-block; color: #fff; font-size: 7.6pt; font-weight: 700; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
.chip.strong { background: #059669; }
table.grid { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 8.6pt; }
table.grid th { background: #111827; color: #fff; text-align: left; padding: 6px 8px; font-weight: 600; }
table.grid td { padding: 6px 8px; border-bottom: 1px solid #E5E7EB; vertical-align: top; }
table.grid tr { break-inside: avoid; }
table.grid tr:nth-child(even) td { background: #F9FAFB; }
table.grid td.sev { width: 13%; }
table.grid td.loc { width: 44%; }
table.grid td.loc code { font-size: 7.8pt; white-space: nowrap; }
table.routes td:nth-child(2) code { white-space: nowrap; }
table.grid td code { background: transparent; padding: 0; }
.cat-title { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 4px; }
.cat-title h3 { margin: 0; }
.na { font-size: 8.6pt; color: #4B5563; margin: 0 0 6px; }

/* pontos fortes/fracos */
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
.cards .card { margin: 0; }
.card { border: 1px solid #E5E7EB; border-left: 5px solid; border-radius: 6px; padding: 7px 10px; margin: 0 0 7px; break-inside: avoid; }
.card h4 { margin: 0 0 3px; font-size: 9.4pt; }
.card p { margin: 0; font-size: 8.5pt; color: #374151; }
.card .tag { font-size: 7.6pt; color: #6B7280; text-transform: uppercase; letter-spacing: .05em; }

/* detalhes */
.finding { border: 1px solid #E5E7EB; border-radius: 6px; margin: 0 0 12px; break-inside: avoid; overflow: hidden; }
.finding header { display: flex; gap: 8px; align-items: center; padding: 7px 10px; background: #F9FAFB; border-bottom: 1px solid #E5E7EB; }
.finding header b { font-size: 9.8pt; }
.finding .body { padding: 8px 10px; }
.finding dl { margin: 0; display: grid; grid-template-columns: 24% 76%; row-gap: 4px; }
.finding dt { font-weight: 600; color: #374151; font-size: 8.6pt; }
.finding dd { margin: 0; font-size: 8.6pt; }
pre.snippet { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 7.8pt; background: #0F172A; color: #E2E8F0; padding: 6px 8px; border-radius: 4px; margin: 2px 0 6px; white-space: pre-wrap; word-break: break-word; }
.snippet-label { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 7.8pt; color: #374151; font-weight: 600; }

/* recomendações */
.rec { display: flex; gap: 10px; border: 1px solid #E5E7EB; border-radius: 6px; padding: 8px 10px; margin: 0 0 8px; break-inside: avoid; }
.rec .p { flex: 0 0 38px; height: 38px; border-radius: 6px; background: #111827; color: #fff; font-weight: 800; display: flex; align-items: center; justify-content: center; font-size: 11pt; }
.rec h4 { margin: 0 0 2px; }
.rec p { margin: 0; font-size: 8.6pt; }

/* issues */
.issue { break-inside: auto; margin: 0 0 14px; }
.issue-head { display: flex; gap: 8px; align-items: center; margin: 0 0 4px; }
pre.md { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 7.9pt; line-height: 1.42; background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; margin: 0; color: #0F172A; }
"""


def build_html() -> str:
    counts = {s: sum(1 for f in FINDINGS if f["sev"] == s) for s in SEV}
    total = len(FINDINGS)
    strong_total = len(STRENGTHS)
    _setup_matplotlib()
    donut = donut_chart(counts)
    bars = bar_chart()

    parts = [f"<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><title>{e(REPORT_TITLE)}</title><style>{CSS}</style></head><body>"]

    # ---- capa
    sevbar = "".join(f'<span style="background:{v["color"]}"></span>' for v in SEV.values()) + f'<span style="background:{STRONG}"></span>'
    parts.append("<section class='cover'>")
    parts.append(f"<div class='band'><div class='kicker'>Auditoria de segurança de código</div><h1>{e(REPORT_TITLE)}</h1>"
                 f"<div class='date'>{REPORT_DATE} · HEAD 4222366 · branch main</div><div class='sevbar'>{sevbar}</div></div>")
    parts.append("<h3>Escopo auditado</h3><table class='kv'>" + "".join(f"<tr><th>{e(k)}</th><td>{v}</td></tr>" for k, v in SCOPE) + "</table>")
    parts.append("<h3>Stack detectada</h3><table class='kv'>" + "".join(f"<tr><th>{e(k)}</th><td>{v}</td></tr>" for k, v in STACK) + "</table>")
    parts.append("<h3>Nota metodológica: como cada categoria foi mapeada para esta stack</h3><table class='method'>"
                 + "".join(f"<tr><td>{c}. {e(CATEGORIES[c])}</td><td>{t}</td></tr>" for c, t in METHOD) + "</table>")
    parts.append("<p class='small muted' style='margin-top:8px'>Regra da auditoria: só entram achados verificados no código real, com arquivo e linha. "
                 "Severidades: crítica, alta, média, baixa e informativa (sem risco explorável hoje, registrado para endurecimento).</p>")
    parts.append("</section>")

    # ---- resumo executivo
    parts.append("<section class='section'><h2>Resumo executivo</h2>")
    parts.append(
        "<p>O SteamTwo tem uma superfície de ataque pequena: não há login, papéis nem dados pessoais; o catálogo é público e a única escrita "
        "pela API é a lista pessoal anônima. Nas cinco categorias, a auditoria encontrou <b>7 achados</b>, nenhum crítico ou alto. "
        "O mais relevante é a <b>senha padrão do PostgreSQL</b> usada como fallback no compose de produção (média). Os demais são vazamentos "
        "de informação operacional no <code>/api/status</code>, falta de cabeçalhos de defesa e pontos de endurecimento. "
        f"Foram registrados <b>{strong_total} pontos fortes</b> com evidência, entre eles o isolamento correto da lista por dono, "
        "confirmado em execução.</p>")
    kpis = "".join(
        f"<div class='kpi' style='border-top-color:{SEV[s]['color']}'><b>{counts[s]}</b><span>{s}</span></div>" for s in SEV)
    kpis += f"<div class='kpi' style='border-top-color:{STRONG}'><b>{strong_total}</b><span>pontos fortes</span></div>"
    parts.append(f"<div class='kpis'>{kpis}</div>")
    legend = "".join(f"<li><i style='background:{SEV[s]['color']}'></i>{s.capitalize()}: {counts[s]}</li>" for s in SEV)
    parts.append(f"<div class='charts'><div class='chart-box donut'><h4>Achados por severidade</h4>{donut}<ul class='legend'>{legend}</ul></div>"
                 f"<div class='chart-box bars'><h4>Achados e pontos fortes por categoria</h4>{bars}</div></div>")
    parts.append("<table class='grid'><tr><th>Categoria</th><th>Aplicabilidade nesta stack</th><th>Achados</th></tr>")
    applic = {
        1: "Parcial: único dado de dono é a lista anônima (filtro por list_id)",
        2: "Não se aplica na forma clássica: não há papéis; avaliado o endpoint operacional",
        3: "Aplica-se às rotas da lista; catálogo é público por desenho",
        4: "Aplica-se: compose, CI, .env.example, histórico e bundle",
        5: "Aplica-se: frontend React e respostas do backend",
    }
    for c in CATEGORIES:
        fs = [f for f in FINDINGS if f["cat"] == c]
        chips = " ".join(f"{chip(f['sev'])} <span class='small'>{f['id']}</span>" for f in fs) or "—"
        parts.append(f"<tr><td><b>{c}. {e(CATEGORIES[c])}</b></td><td>{e(applic[c])}</td><td>{chips}</td></tr>")
    parts.append("</table>")
    parts.append("<div class='callout small'><b>Condição de explorabilidade mais importante:</b> A1 depende de alguém alcançar a porta do banco. "
                 "Com a configuração atual (porta só em 127.0.0.1) isso exige acesso ao host ou à rede Docker. Entre os commits 539d90c e 5498fcb, "
                 "e no projeto-base, a porta ficava aberta em todas as interfaces com essa senha.</div>")
    parts.append("</section>")

    # ---- pontos fortes e fracos
    weak = [
        ("média", "Segredo padrão vira segredo real", "O compose “de produção” cai para a senha pública steamtwo quando POSTGRES_PASSWORD falta, e não há validação no startup que impeça isso (A1, A2)."),
        ("baixa", "Diagnóstico público demais", "/api/status, sem controle de acesso, devolve mensagens cruas de exceção dos jobs e o total de itens de todas as listas (A3, A4)."),
        ("baixa", "Sem segunda barreira no navegador", "Sem CSP nem anti-framing: uma falha futura de XSS teria impacto pleno (A5)."),
        ("informativa", "Garantias implícitas", "Links de loja e posse da lista dependem de convenções (todo produtor gera https; o UUID nunca vaza), sem validação central (A6, A7)."),
    ]
    parts.append("<section class='section'><h2>Pontos fortes e pontos fracos</h2>")
    parts.append("<h3 style='color:#B91C1C;margin-top:0'>Pontos fracos (riscos centrais)</h3><div class='cards'>")
    for sev, title, text in weak:
        parts.append(f"<div class='card' style='border-left-color:{SEV[sev]['color']}'>{chip(sev)}<h4 style='margin-top:4px'>{e(title)}</h4><p>{e(text)}</p></div>")
    parts.append("</div><h3 style='color:#059669'>Pontos fortes (verificados, com evidência)</h3><div class='cards'>")
    for cat, title, ev in STRENGTHS:
        tag = CAT_SHORT.get(cat, "Transversal")
        parts.append(f"<div class='card' style='border-left-color:{STRONG}'><span class='tag'>{e(tag)}</span><h4>{e(title)}</h4><p>{e(ev)}</p></div>")
    parts.append("</div><h3>Fora das cinco categorias (não contados)</h3><ul class='small'>" + "".join(f"<li>{e(t)}</li>" for t in OUT_OF_SCOPE) + "</ul>")
    parts.append("</section>")

    # ---- tabela por categoria
    parts.append("<section class='section'><h2>Achados detalhados por categoria</h2>")
    na_notes = {
        2: "Não há gate de papel no frontend nem papéis no backend; nenhuma ação privilegiada é exposta por HTTP. O único item é um endpoint operacional sem controle de acesso.",
    }
    for c in CATEGORIES:
        fs = sorted([f for f in FINDINGS if f["cat"] == c], key=lambda f: SEV[f["sev"]]["order"])
        parts.append(f"<div class='cat-title'><h3>{c}. {e(CATEGORIES[c])}</h3><span class='muted small'>{len(fs)} achado(s)</span></div>")
        if c in na_notes:
            parts.append(f"<p class='na'>{e(na_notes[c])}</p>")
        parts.append("<table class='grid'><tr><th>Severidade</th><th>Arquivo:linha</th><th>Descrição</th></tr>")
        for f in fs:
            parts.append(f"<tr><td class='sev'>{chip(f['sev'])}<br><span class='small muted'>{f['id']}</span></td><td class='loc'>{loc_text(f)}</td><td>{e(f['title'])}</td></tr>")
        parts.append("</table>")

    parts.append("<h3>Cobertura de IDOR: todos os handlers da API</h3><table class='grid routes'><tr><th>Método</th><th>Rota</th><th>routes/index.js</th><th>Entrada de ID</th><th>Verificação</th><th>Resultado</th></tr>")
    for m, r, line, ident, check, res in ROUTES:
        parts.append(f"<tr><td>{m}</td><td><code>{e(r)}</code></td><td>:{line}</td><td>{e(ident)}</td><td>{e(check)}</td><td>{e(res)}</td></tr>")
    parts.append("</table></section>")

    # ---- detalhes
    parts.append("<section class='section'><h2>Evidência de cada achado</h2>")
    for f in sorted(FINDINGS, key=lambda f: (SEV[f["sev"]]["order"], f["id"])):
        snippets = "".join(f"<div class='snippet-label'>{e(p)}:{e(l)}</div><pre class='snippet'>{e(code)}</pre>" for p, l, code in f["locs"])
        parts.append(
            f"<article class='finding'><header>{chip(f['sev'])}<b>{f['id']} · {e(f['title'])}</b></header><div class='body'>{snippets}"
            f"<dl><dt>Categoria</dt><dd>{f['cat']}. {e(CATEGORIES[f['cat']])}</dd>"
            f"<dt>Por que é explorável</dt><dd>{e(f['why'])}</dd>"
            f"<dt>Condição</dt><dd>{e(f['cond'])}</dd>"
            f"<dt>Impacto</dt><dd>{e(f['impact'])}</dd>"
            f"<dt>Origem no histórico</dt><dd>{e(f['origin'])}</dd></dl></div></article>")
    parts.append("</section>")

    # ---- recomendações
    parts.append("<section class='section'><h2>Recomendações priorizadas</h2>")
    for p, sev, ids, title, text in RECOMMENDATIONS:
        refs = f" <span class='small muted'>({', '.join(ids)})</span>" if ids else ""
        badge = chip(sev) if sev in SEV else ""
        parts.append(f"<div class='rec'><div class='p'>{p}</div><div><h4>{e(title)}{refs} {badge}</h4><p>{text}</p></div></div>")
    parts.append("</section>")

    # ---- verificação independente e comunicação ao proprietário
    parts.append(
        "<section class='section'><h2>Verificação independente e comunicação ao proprietário</h2>"
        "<h3>Confirmação dos achados</h3>"
        "<p>Depois da execução do prompt, os achados principais foram reproduzidos de forma independente na instância local "
        "(<code>docker compose up</code>, dados fictícios), em 24/11/2026:</p><table class='kv'>"
        "<tr><th>A1</th><td><code>docker compose config</code> sem <code>POSTGRES_PASSWORD</code> resolve "
        "<code>DATABASE_URL: postgres://steamtwo:steamtwo@postgres:5432/steamtwo</code> — a API sobe com a senha pública.</td></tr>"
        "<tr><th>A3</th><td><code>GET /api/status</code> sem cabeçalho algum retorna <code>\"watchlistItems\": 2</code> — total de itens de "
        "<b>todas</b> as listas, de qualquer visitante.</td></tr>"
        "<tr><th>A4</th><td>Com um <code>sync_run</code> fictício com falha, <code>GET /api/status</code> devolveu a mensagem crua do PostgreSQL "
        "(<code>duplicate key value violates unique constraint …</code>) a um visitante anônimo. O registro fictício foi removido em seguida.</td></tr>"
        "<tr><th>A5</th><td>Cabeçalhos da resposta de <code>GET /</code>: <code>Content-Security-Policy</code>, <code>X-Frame-Options</code> e "
        "<code>X-Content-Type-Options</code> ausentes.</td></tr></table>"
        "<h3>Registro da comunicação</h3>"
        "<table class='kv'>"
        "<tr><th>Proprietário</th><td>João Hideki Takayasu (autor e mantenedor do SaaS auditado)</td></tr>"
        "<tr><th>Canal</th><td>Issues no repositório do projeto, com labels <code>security</code> e de severidade</td></tr>"
        "<tr><th>Data</th><td>25/11/2026 (horário UTC 01:55)</td></tr>"
        "<tr><th>Evidência</th><td>"
        "<a href='https://github.com/joao-hideki/steamtwo-melhorias/issues/1'>#1</a> credencial padrão do PostgreSQL (média) · "
        "<a href='https://github.com/joao-hideki/steamtwo-melhorias/issues/2'>#2</a> <code>/api/status</code> expõe erros internos e total global (baixa) · "
        "<a href='https://github.com/joao-hideki/steamtwo-melhorias/issues/3'>#3</a> cabeçalhos de segurança e URLs de loja (baixa) · "
        "<a href='https://github.com/joao-hideki/steamtwo-melhorias/issues/4'>#4</a> endurecer o <code>X-List-Id</code> (informativa)"
        "</td></tr>"
        "<tr><th>Conteúdo</th><td>Cada issue explica o problema, a evidência (arquivo:linha), o impacto, a correção sugerida e critérios de aceite. "
        "Nenhum token, senha real ou dado pessoal foi incluído — a única credencial citada é o valor padrão público de desenvolvimento.</td></tr>"
        "</table>"
        "<p class='small'>Achados que já existiam no projeto-base (A1, A2, A5) foram registrados como tal; a comunicação foi feita ao "
        "proprietário do repositório auditado, que é o responsável pela versão em uso.</p></section>")

    # ---- issues
    parts.append("<section class='section'><h2>ISSUES PARA O GITHUB</h2>"
                 "<p class='small'>Cada bloco abaixo é o texto completo de uma issue em Markdown, pronto para copiar e colar. "
                 "Achados relacionados foram agrupados para não gerar issues repetidas. A7 (informativa) foi mantido como issue porque tem correção concreta.</p>")
    for i, issue in enumerate(ISSUES, 1):
        sev = issue["labels"].split("severidade:")[1]
        md = (f"--- ISSUE {i} ---\n"
              f"# {issue['title']}\n\n"
              f"**Labels sugeridas:** {issue['labels']}\n"
              f"**Achados do relatório:** {issue['findings']}\n\n"
              f"{issue['body'].strip()}\n"
              f"--- FIM ISSUE {i} ---")
        parts.append(f"<div class='issue'><div class='issue-head'>{chip(sev)}<b>Issue {i}</b><span class='small muted'>{e(issue['findings'])}</span></div><pre class='md'>{e(md)}</pre></div>")
    parts.append("</section></body></html>")
    return "".join(parts)


# ----------------------------------------------------------------------------- PDF


def find_edge() -> str:
    for candidate in EDGE_CANDIDATES:
        if Path(candidate).exists():
            return candidate
    found = shutil.which("msedge")
    if found:
        return found
    sys.exit("Microsoft Edge não encontrado; ajuste EDGE_CANDIDATES.")


def render_pdf(html_path: Path, pdf_path: Path) -> None:
    edge = find_edge()
    with tempfile.TemporaryDirectory() as profile:
        cmd = [edge, "--headless=new", "--disable-gpu", "--no-first-run", "--no-pdf-header-footer",
               f"--user-data-dir={profile}", f"--print-to-pdf={pdf_path}", html_path.as_uri()]
        subprocess.run(cmd, check=True, timeout=180, capture_output=True)
    if not pdf_path.exists() or pdf_path.stat().st_size == 0:
        sys.exit("Falha ao gerar o PDF.")


def preview(pdf_path: Path, out_dir: Path) -> None:
    import pypdfium2 as pdfium

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf = pdfium.PdfDocument(str(pdf_path))
    for index in range(len(pdf)):
        page = pdf[index]
        w, h = page.get_size()
        page.render(scale=1.6).to_pil().save(out_dir / f"pagina-{index + 1:02d}.png")
        print(f"página {index + 1}: {w / 72 * 25.4:.0f} x {h / 72 * 25.4:.0f} mm")
    print(f"{len(pdf)} páginas rasterizadas em {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--preview", type=Path, help="diretório para PNGs de cada página")
    args = parser.parse_args()
    HTML_OUT.write_text(build_html(), encoding="utf-8")
    render_pdf(HTML_OUT, PDF_OUT)
    print(f"HTML: {HTML_OUT}\nPDF:  {PDF_OUT} ({PDF_OUT.stat().st_size // 1024} KiB)")
    if args.preview:
        preview(PDF_OUT, args.preview)


if __name__ == "__main__":
    os.chdir(HERE)
    main()
