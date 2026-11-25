import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownRight, ArrowLeft, ArrowRight, ArrowSquareOut, ArrowUpRight, BookmarkSimple, CaretDown, CaretLeft, CaretRight,
  ChartLineUp, Check, Circle, Database, FunnelSimple, GameController, Heartbeat, Info, MagnifyingGlass, Trash,
  TrendUp, UsersThree, Warning, X,
} from "@phosphor-icons/react";
import { getJson, listApi, query } from "./api.js";
import { formatDate, formatNumber, formatScore, SOURCE_STATUS, storeKeys, storeLabel, storeUrl } from "./format.js";

const FALLBACK_IMAGE = "https://images.unsplash.com/photo-1511512578047-dfb367046420?auto=format&fit=crop&w=600&q=80";
const PERIODS = [["now", "Agora"], ["week", "Última semana"], ["all-time", "De sempre"]];

// ---------------------------------------------------------------- roteamento

function parseLocation() {
  const path = window.location.pathname;
  if (path.startsWith("/jogos/")) return { view: "detail", slug: decodeURIComponent(path.slice("/jogos/".length)) };
  if (path.startsWith("/catalogo")) return { view: "catalog" };
  if (path.startsWith("/rankings")) return { view: "rankings" };
  if (path.startsWith("/minha-lista")) return { view: "list" };
  if (path.startsWith("/status")) return { view: "status" };
  return { view: "home" };
}

const PATHS = { home: "/", catalog: "/catalogo", rankings: "/rankings", list: "/minha-lista", status: "/status" };

// ---------------------------------------------------------------- hooks

/** Busca JSON e cancela a requisição anterior quando os parâmetros mudam. */
function useApi(path, deps = [path]) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!path) return undefined;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    getJson(path, { signal: controller.signal })
      .then((data) => setState({ data, loading: false, error: null }))
      .catch((error) => { if (error.name !== "AbortError") setState({ data: null, loading: false, error }); });
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Lista pessoal persistida no PostgreSQL via /api/list. */
function useWatchlist(notify) {
  const [slugs, setSlugs] = useState(() => new Set());
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listApi.items(controller.signal)
      .then((payload) => setSlugs(new Set(payload.items.map((game) => game.slug))))
      .catch(() => {});
    return () => controller.abort();
  }, [version]);

  const toggle = useCallback(async (game) => {
    const inList = slugs.has(game.slug);
    try {
      if (inList) await listApi.remove(game.slug);
      else await listApi.add(game.slug);
      setSlugs((current) => {
        const next = new Set(current);
        if (inList) next.delete(game.slug); else next.add(game.slug);
        return next;
      });
      setVersion((value) => value + 1);
      notify(inList ? `${game.title} saiu da sua lista` : `${game.title} foi adicionado à sua lista`);
    } catch (error) {
      notify(`Não foi possível atualizar a lista: ${error.message}`, "error");
    }
  }, [slugs, notify]);

  return { slugs, toggle, version };
}

// ---------------------------------------------------------------- componentes básicos

function SafeImage({ src, alt, className = "", ...props }) {
  const [url, setUrl] = useState(src || FALLBACK_IMAGE);
  useEffect(() => setUrl(src || FALLBACK_IMAGE), [src]);
  return <img className={className} src={url} alt={alt} loading="lazy" onError={() => setUrl(FALLBACK_IMAGE)} {...props} />;
}

function Trend({ value, compact = false }) {
  if (!value) return <span className="trend neutral" aria-label="Sem variação">—</span>;
  const positive = value > 0;
  const Icon = positive ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`trend ${positive ? "positive" : "negative"}`} aria-label={`${positive ? "Subiu" : "Caiu"} ${Math.abs(value)} posições`}>
      <Icon size={compact ? 15 : 16} weight="bold" /> {Math.abs(value)}
    </span>
  );
}

const Score = ({ value, large = false }) => <span className={large ? "score score-large" : "score"}>{formatScore(value)}</span>;

function ListButton({ game, watchlist, compact = false }) {
  const inList = watchlist.slugs.has(game.slug);
  return (
    <button className={`list-button ${inList ? "in-list" : ""}`} aria-pressed={inList} onClick={(event) => { event.stopPropagation(); watchlist.toggle(game); }}>
      {inList ? <Check size={19} weight="bold" /> : <BookmarkSimple size={19} />}
      {!compact && (inList ? "Na sua lista" : "Adicionar à lista")}
    </button>
  );
}

function StoreFilters({ value, onChange, label = "Filtrar por loja" }) {
  return (
    <div className="store-filter" role="radiogroup" aria-label={label}>
      {[["all", "Todos"], ["steam", "Steam"], ["epic", "Epic Games"]].map(([key, text]) => (
        <button key={key} className={value === key ? "selected" : ""} onClick={() => onChange(key)} role="radio" aria-checked={value === key}>{text}</button>
      ))}
    </div>
  );
}

function ModeBadge({ mode }) {
  if (!mode) return null;
  const database = mode === "database";
  return (
    <span className={`mode-badge ${database ? "ok" : "warn"}`} title={database ? "Dados lidos do PostgreSQL" : "Sem DATABASE_URL: dados de exemplo"}>
      <Database size={14} weight="bold" /> {database ? "PostgreSQL" : "Demonstração"}
    </span>
  );
}

function EmptyState({ icon: Icon = GameController, title, children }) {
  return <div className="empty-state" role="status"><Icon size={34} /><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}

function ErrorState({ error }) {
  return (
    <EmptyState icon={Warning} title="Não foi possível carregar os dados">
      {error?.message ?? "A API não respondeu."} Verifique se o servidor está rodando (<code>docker compose up</code>).
    </EmptyState>
  );
}

// ---------------------------------------------------------------- layout

function Header({ view, onNavigate, search, setSearch, mode, listCount }) {
  const items = [["home", "Início"], ["catalog", "Catálogo"], ["rankings", "Rankings"], ["list", `Minha lista${listCount ? ` (${listCount})` : ""}`]];
  return (
    <header className={`site-header ${view === "home" ? "site-header-overlay" : ""}`}>
      <button className="brand" onClick={() => onNavigate("home")} aria-label="SteamTwo, início"><span>Steam</span><b>Two</b></button>
      <nav aria-label="Navegação principal">
        {items.map(([key, label]) => (
          <button key={key} className={view === key ? "active" : ""} aria-current={view === key ? "page" : undefined} onClick={() => onNavigate(key)}>{label}</button>
        ))}
      </nav>
      <ModeBadge mode={mode} />
      <label className="search-box">
        <MagnifyingGlass size={20} aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => { setSearch(event.target.value); if (view !== "catalog") onNavigate("catalog"); }}
          placeholder="Buscar jogos"
          aria-label="Buscar jogos no catálogo"
          type="search"
        />
      </label>
    </header>
  );
}

// ---------------------------------------------------------------- início

function Hero({ game, updatedAt, onDetails, onMethodology, watchlist }) {
  return (
    <section className="hero" style={{ "--hero-image": `url(${game.heroUrl || game.coverUrl || FALLBACK_IMAGE})` }}>
      <div className="hero-content">
        <div className="spotlight"><span>DATA SPOTLIGHT</span><Circle size={7} weight="fill" color="var(--blue)" /> <time dateTime={updatedAt ?? undefined}>Atualizado em {formatDate(updatedAt, { withTime: true })}</time></div>
        <div className="eyebrow">O JOGO DO MOMENTO</div>
        <h1>{game.title}</h1>
        <p>{game.summary || "Sem descrição disponível para este jogo."}</p>
        <div className="hero-actions">
          <button className="primary-button" onClick={onDetails}>Ver detalhes</button>
          <ListButton game={game} watchlist={watchlist} />
        </div>
      </div>
      <aside className="hero-score">
        <div className="score-heading"><h2>Índice SteamTwo</h2><button onClick={onMethodology}>Como calculamos <Info size={15} /></button></div>
        <div><Score value={game.score} large /> <span className="out-of">/100</span></div>
        <p>Calculado a partir da posição do jogo nos rankings das lojas que o vendem ({storeKeys(game).map(storeLabel).join(" e ") || "—"}).</p>
        <div className="score-lines">
          <span><TrendUp size={19} /> Posição agora <b>#{game.rank ?? "—"}</b></span>
          <span><UsersThree size={19} /> Jogadores Steam agora <b>{formatNumber(game.metric?.type === "players" ? game.metric.value : game.currentPlayers)}</b></span>
          <span><ChartLineUp size={19} /> Popularidade histórica <b>{game.historicalPopularity ? formatScore(game.historicalPopularity) : "—"}</b></span>
        </div>
        <small>Lojas: {storeKeys(game).map(storeLabel).join(" · ") || "—"}</small>
      </aside>
    </section>
  );
}

function TopStrip({ items, onDetails }) {
  return (
    <section className="top-strip" aria-label="Top cinco agora">
      {items.map((game) => (
        <button className="top-item" key={game.id} onClick={() => onDetails(game)}>
          <strong>{game.rank}</strong>
          <SafeImage src={game.coverUrl} alt="" />
          <span><b>{game.title}</b><Score value={game.score} /><Trend value={game.trend} compact /></span>
        </button>
      ))}
    </section>
  );
}

function RankList({ items, onDetails }) {
  if (!items.length) return <EmptyState title="Sem dados para este filtro">Nenhum jogo desta loja na última coleta.</EmptyState>;
  return (
    <div className="week-list">
      {items.map((game) => (
        <button className="week-row" key={game.id} onClick={() => onDetails(game)}>
          <strong>{game.rank}</strong><SafeImage src={game.coverUrl} alt="" /><span className="week-title">{game.title}</span><Score value={game.score} /><Trend value={game.trend} />
        </button>
      ))}
    </div>
  );
}

function Home({ onDetails, onNavigate, onMethodology, watchlist, onMode }) {
  const [store, setStore] = useState("all");
  const { data, loading, error } = useApi(`/dashboard${query({ store })}`);
  useEffect(() => { if (data?.mode) onMode(data.mode); }, [data, onMode]);

  if (error) return <div className="page-shell"><ErrorState error={error} /></div>;
  if (!data && loading) return <div className="page-shell"><EmptyState title="Carregando dashboard">Consultando a API…</EmptyState></div>;
  if (!data.hero && store === "all") {
    return (
      <div className="page-shell">
        <EmptyState icon={Database} title="Banco conectado, mas ainda sem rankings">
          Rode a coleta (<code>npm run sync:all</code> ou o serviço <code>sync</code> do docker compose) para preencher o dashboard.
        </EmptyState>
      </div>
    );
  }
  const record = data.records?.[0];
  return (
    <>
      {data.hero && <Hero game={data.hero} updatedAt={data.updatedAt} onDetails={() => onDetails(data.hero)} onMethodology={onMethodology} watchlist={watchlist} />}
      {data.topFive.length > 0 && <TopStrip items={data.topFive} onDetails={onDetails} />}
      <section className="dashboard-grid">
        <div className="week-panel">
          <div className="section-head">
            <div><h2>ÚLTIMA SEMANA</h2><p>Média dos snapshots diários até {formatDate(data.updatedAt)}</p></div>
            <StoreFilters value={store} onChange={setStore} />
          </div>
          <RankList items={data.week} onDetails={onDetails} />
          <button className="more-link" onClick={() => onNavigate("rankings")}>Ver ranking completo <ArrowRight size={19} /></button>
        </div>
        <div className="alltime-panel">
          <div className="section-head"><div><h2>DE SEMPRE</h2><p>{data.allTime[0]?.metric?.type === "peak"
            ? "Maior Índice SteamTwo que cada jogo já atingiu nas coletas."
            : "Popularidade histórica (IGDB)."}</p></div></div>
          <div className="poster-grid">
            {data.allTime.map((game) => (
              <button className="poster" key={game.id} onClick={() => onDetails(game)}>
                <SafeImage src={game.coverUrl} alt={`Capa de ${game.title}`} /><span className="poster-score">{formatScore(game.score)}</span>
              </button>
            ))}
          </div>
          <button className="more-link" onClick={() => onNavigate("rankings")}>Ver todos os tempos <ArrowRight size={19} /></button>
        </div>
        {record && (
          <button className="record-card" onClick={() => onDetails(record.game)}>
            <div className="section-kicker">RECORDE MONITORADO</div>
            <p>{record.label}</p><Score value={record.value} /><SafeImage src={record.game.coverUrl} alt="" />
            <b>{record.game.title}</b><small>Alcançado em<br />{formatDate(record.achievedAt)}</small>
          </button>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------- catálogo

function GameCard({ game, onDetails, watchlist, onRemove }) {
  return (
    <article className="game-card-wrap">
      <button className="game-card" onClick={() => onDetails(game)}>
        <SafeImage src={game.coverUrl} alt={`Capa de ${game.title}`} />
        <div>
          <span className="game-card-score"><Score value={game.score} /></span>
          <h3>{game.title}</h3>
          <p>{game.genres.join(" · ") || "Sem gênero informado"}</p>
          <span className="card-stores">{storeKeys(game).map(storeLabel).join(" · ")}</span>
        </div>
      </button>
      {onRemove
        ? <button className="card-action" onClick={() => onRemove(game)} aria-label={`Remover ${game.title} da lista`}><Trash size={16} /></button>
        : <div className="card-action-slot"><ListButton game={game} watchlist={watchlist} compact /></div>}
    </article>
  );
}

function Catalog({ search, onDetails, watchlist }) {
  const [store, setStore] = useState("all");
  const [genre, setGenre] = useState("all");
  const [sort, setSort] = useState("popularity");
  const [pages, setPages] = useState(1);
  const q = useDebounced(search.trim());
  useEffect(() => setPages(1), [q, store, genre, sort]);

  const genres = useApi("/genres");
  const { data, loading, error } = useApi(`/games${query({ q, store, genre, sort, limit: 12 * pages })}`);
  const items = data?.items ?? [];
  const total = data?.pagination?.total ?? 0;

  return (
    <section className="catalog-page">
      <div className="page-intro">
        <div><span className="eyebrow">BIBLIOTECA STEAMTWO</span><h1>Catálogo de jogos</h1><p>Busca, filtros e ordenação feitos no PostgreSQL pela API.</p></div>
        <GameController size={58} weight="thin" aria-hidden="true" />
      </div>
      <div className="catalog-toolbar">
        <div className="filter-control"><FunnelSimple size={18} aria-hidden="true" /><StoreFilters value={store} onChange={setStore} /></div>
        <div className="toolbar-selects">
          <label className="select-control">Gênero
            <select value={genre} onChange={(event) => setGenre(event.target.value)}>
              <option value="all">Todos os gêneros</option>
              {(genres.data?.items ?? []).map((item) => <option value={item.name} key={item.name}>{item.name} ({item.games})</option>)}
            </select><CaretDown size={16} aria-hidden="true" />
          </label>
          <label className="select-control">Ordenar
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="popularity">Mais populares</option>
              <option value="name">Nome (A–Z)</option>
            </select><CaretDown size={16} aria-hidden="true" />
          </label>
        </div>
      </div>
      <p className="result-count" aria-live="polite">{loading ? "Buscando…" : `${formatNumber(total)} jogo(s) encontrado(s)${q ? ` para “${q}”` : ""}`}</p>
      {error ? <ErrorState error={error} />
        : !items.length && !loading ? <EmptyState title="Nenhum jogo encontrado">Tente outra busca ou remova algum filtro.</EmptyState>
          : <div className="catalog-grid">{items.map((game) => <GameCard game={game} onDetails={onDetails} watchlist={watchlist} key={game.id} />)}</div>}
      {items.length < total && !loading && (
        <button className="load-more" onClick={() => setPages((value) => value + 1)}>Carregar mais ({formatNumber(total - items.length)} restantes)</button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- rankings

function Rankings({ onDetails, initialPeriod = "now" }) {
  const [period, setPeriod] = useState(initialPeriod);
  const [store, setStore] = useState("all");
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [period, store]);
  const { data, loading, error } = useApi(`/rankings${query({ period, store, page, limit: 15 })}`);
  const items = data?.items ?? [];
  const pagination = data?.pagination;
  const metricLabel = period === "all-time"
    ? (items[0]?.metric?.type === "peak" ? "Pico do índice" : "Popularidade")
    : period === "week" ? "Dias válidos" : "Jogadores Steam";

  return (
    <section className="rankings-page">
      <div className="page-intro">
        <div><span className="eyebrow">RANKINGS</span><h1>Quem está no topo?</h1><p>Índice SteamTwo calculado a partir das coletas Steam e Epic gravadas no banco.</p></div>
        <ChartLineUp size={58} weight="thin" aria-hidden="true" />
      </div>
      <div className="catalog-toolbar">
        <div className="period-tabs" role="tablist" aria-label="Período do ranking">
          {PERIODS.map(([key, label]) => (
            <button key={key} role="tab" aria-selected={period === key} className={period === key ? "selected" : ""} onClick={() => setPeriod(key)}>{label}</button>
          ))}
        </div>
        <StoreFilters value={store} onChange={setStore} />
      </div>
      {data?.updatedAt && <p className="result-count">Cálculo de {formatDate(data.updatedAt, { withTime: true })}</p>}
      {error ? <ErrorState error={error} />
        : !items.length && !loading ? <EmptyState title="Sem ranking para este filtro">A última coleta não tem jogos desta loja/período.</EmptyState>
          : (
            <div className="ranking-table with-metric" role="table" aria-label={`Ranking ${PERIODS.find(([key]) => key === period)[1]}`}>
              <div className="table-head" role="row"><span>#</span><span>Jogo</span><span>Índice SteamTwo</span><span>{metricLabel}</span><span>Variação</span></div>
              {items.map((game) => (
                <button className="table-row" role="row" key={game.id} onClick={() => onDetails(game)}>
                  <strong>{game.rank}</strong>
                  <span><SafeImage src={game.coverUrl} alt="" /><b>{game.title}</b></span>
                  <Score value={game.score} />
                  <span className="metric-cell">{["popularity", "peak"].includes(game.metric?.type) ? formatScore(game.metric.value) : formatNumber(game.metric?.value)}</span>
                  <Trend value={game.trend} />
                </button>
              ))}
            </div>
          )}
      {pagination && pagination.pages > 1 && (
        <nav className="pagination" aria-label="Paginação do ranking">
          <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><CaretLeft size={16} /> Anterior</button>
          <span>Página {pagination.page} de {pagination.pages}</span>
          <button disabled={page >= pagination.pages} onClick={() => setPage((value) => value + 1)}>Próxima <CaretRight size={16} /></button>
        </nav>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- detalhe

function Detail({ slug, onBack, onMethodology, watchlist }) {
  const { data: game, loading, error } = useApi(`/games/${encodeURIComponent(slug)}`);
  if (error) {
    return <section className="detail-page"><button className="back-link" onClick={onBack}><ArrowLeft size={17} /> Voltar</button>
      {error.status === 404 ? <EmptyState title="Jogo não encontrado">Esse jogo não está no catálogo.</EmptyState> : <ErrorState error={error} />}</section>;
  }
  if (!game || loading) return <section className="detail-page"><EmptyState title="Carregando jogo" /></section>;
  const stores = storeKeys(game);
  return (
    <section className="detail-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={17} /> Voltar</button>
      <div className="detail-hero" style={{ "--detail-image": `url(${game.heroUrl || game.coverUrl || FALLBACK_IMAGE})` }}>
        <div>
          <span className="eyebrow">DETALHE DO JOGO</span>
          <h1>{game.title}</h1>
          <div className="detail-tags">{game.genres.map((genre) => <span key={genre}>{genre}</span>)}</div>
          <p>{game.summary || "Sem descrição disponível."}</p>
          <div className="detail-actions">
            {stores.map((store) => (
              <a className="primary-button" key={store} href={storeUrl(game, store)} target="_blank" rel="noreferrer">Abrir na {storeLabel(store)} <ArrowSquareOut size={17} /></a>
            ))}
            <ListButton game={game} watchlist={watchlist} />
          </div>
        </div>
        <div className="detail-score">
          <span>ÍNDICE STEAMTWO</span><Score value={game.score} large /><small>/ 100</small>
          <button onClick={onMethodology}>Como calculamos <Info size={14} /></button>
        </div>
      </div>
      <div className="detail-columns">
        <article>
          <h2>Números da última coleta</h2>
          <dl className="stats-grid">
            <div><dt>Posição no ranking agora</dt><dd>{game.currentRank ? `#${game.currentRank}` : "Fora do top"}</dd></div>
            <div><dt>Jogadores simultâneos (Steam)</dt><dd>{formatNumber(game.currentPlayers)}</dd></div>
            <div><dt>Variação de posição</dt><dd><Trend value={game.trend} /></dd></div>
            <div><dt>Popularidade histórica</dt><dd>{game.historicalPopularity ? formatScore(game.historicalPopularity) : "—"}</dd></div>
          </dl>
        </article>
        <aside>
          <h2>Fontes</h2>
          <div className="source-pills">{stores.map((store) => <span key={store}><Check size={14} /> {storeLabel(store)}</span>)}</div>
          <small>Última atualização do índice: {formatDate(game.updatedAt, { withTime: true })}</small>
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- minha lista

function MyList({ onDetails, watchlist, onNavigate }) {
  // A lista exige o cabeçalho X-List-Id, por isso usa o cliente próprio (listApi).
  const [items, setItems] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    listApi.items(controller.signal).then((payload) => setItems(payload.items)).catch(() => setItems([]));
    return () => controller.abort();
  }, [watchlist.version]);

  return (
    <section className="catalog-page">
      <div className="page-intro">
        <div><span className="eyebrow">SALVOS NO POSTGRESQL</span><h1>Minha lista</h1><p>Jogos que você marcou com “Adicionar à lista”. Ficam salvos neste navegador.</p></div>
        <BookmarkSimple size={58} weight="thin" aria-hidden="true" />
      </div>
      {items === null ? <EmptyState title="Carregando sua lista" />
        : !items.length ? (
          <EmptyState icon={BookmarkSimple} title="Sua lista está vazia">
            <button className="inline-link" onClick={() => onNavigate("catalog")}>Explore o catálogo</button> e use o marcador para salvar jogos.
          </EmptyState>
        ) : (
          <div className="catalog-grid">
            {items.map((game) => <GameCard game={game} key={game.id} onDetails={onDetails} watchlist={watchlist} onRemove={(item) => watchlist.toggle(item)} />)}
          </div>
        )}
    </section>
  );
}

// ---------------------------------------------------------------- status

function Status() {
  const { data, loading, error } = useApi("/status");
  if (error) return <section className="catalog-page"><ErrorState error={error} /></section>;
  if (!data || loading) return <section className="catalog-page"><EmptyState title="Consultando status" /></section>;
  const sources = data.sources ?? {};
  return (
    <section className="catalog-page">
      <div className="page-intro">
        <div><span className="eyebrow">TRANSPARÊNCIA</span><h1>Status da integração</h1><p>O que está no banco e como foram as últimas coletas.</p></div>
        <Heartbeat size={58} weight="thin" aria-hidden="true" />
      </div>
      <div className="status-grid">
        <div className="status-card"><span>Modo</span><b><ModeBadge mode={data.mode} /></b></div>
        {Object.entries(data.counts ?? {}).map(([key, value]) => (
          <div className="status-card" key={key}><span>{{ games: "Jogos", listings: "Vínculos com lojas", snapshots: "Snapshots coletados", rankings: "Linhas de ranking", watchlistItems: "Itens em listas" }[key] ?? key}</span><b>{formatNumber(value)}</b></div>
        ))}
      </div>
      <h2 className="status-title">Fontes</h2>
      <div className="status-grid">
        {["steam", "epic", "igdb"].map((source) => {
          const state = SOURCE_STATUS[sources[source]] ?? SOURCE_STATUS.unavailable;
          const detail = sources.details?.[source];
          return (
            <div className="status-card" key={source}>
              <span>{source === "igdb" ? "IGDB" : storeLabel(source)}</span>
              <b className={`tone-${state.tone}`}>{state.label}</b>
              {detail && <small>Última coleta: {formatDate(detail.capturedAt, { withTime: true })} · {detail.totalEntries} posições</small>}
              {source === "igdb" && sources.igdb !== "fresh" && <small>Opcional: requer TWITCH_CLIENT_ID/SECRET. O catálogo usa a loja Steam.</small>}
            </div>
          );
        })}
      </div>
      {data.lastRuns?.length > 0 && (
        <>
          <h2 className="status-title">Últimas execuções dos jobs (tabela sync_runs)</h2>
          <div className="ranking-table runs-table" role="table">
            <div className="table-head" role="row"><span role="columnheader">Job</span><span role="columnheader">Situação</span><span role="columnheader">Início</span><span role="columnheader">Registros / erro</span></div>
            {data.lastRuns.map((run) => (
              <div className="table-row" role="row" key={run.job}>
                <b role="cell">{run.job}</b>
                <span role="cell" className={`tone-${run.state === "success" ? "ok" : run.state === "failed" ? "bad" : "warn"}`}>{run.state}</span>
                <span role="cell">{formatDate(run.startedAt, { withTime: true })}</span>
                <span role="cell">{run.error ?? formatNumber(run.details?.records)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- metodologia

function Methodology({ onClose }) {
  const closeRef = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeRef.current?.focus();
    const handleKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="methodology-modal" role="dialog" aria-modal="true" aria-labelledby="method-title">
        <button ref={closeRef} className="modal-close" aria-label="Fechar" onClick={onClose}><X size={20} /></button>
        <span className="eyebrow">TRANSPARÊNCIA</span>
        <h2 id="method-title">Como calculamos</h2>
        <p>Cada posição é normalizada por <b>100 × (N − posição + 1) / N</b>. O índice é a média das lojas <b>que vendem o jogo</b>: estar fora do top de uma loja onde o jogo é vendido vale zero, mas um exclusivo da Steam não é punido por não aparecer na Epic. Uma loja sem coleta válida nas últimas 24 h fica fora do cálculo.</p>
        <div className="method-grid">
          <div><strong>01</strong><h3>Agora</h3><p>Último snapshot válido da Steam (jogadores simultâneos / mais jogados) e da Epic (mais jogados).</p></div>
          <div><strong>02</strong><h3>Semana</h3><p>Média dos snapshots diários válidos dos últimos sete dias.</p></div>
          <div><strong>03</strong><h3>De sempre</h3><p>Popularidade histórica da IGDB, quando configurada; sem ela, o maior índice que cada jogo já atingiu nas coletas.</p></div>
        </div>
        <small className="method-foot">Fontes: Steam Charts, Epic Games Store (com fallback egdata) e IGDB.</small>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- app

export function App() {
  const [route, setRoute] = useState(parseLocation);
  const [search, setSearch] = useState("");
  const [methodology, setMethodology] = useState(false);
  const [mode, setMode] = useState(null);
  const [toast, setToast] = useState(null);
  const notify = useCallback((message, tone = "ok") => setToast({ message, tone, id: Date.now() }), []);
  const watchlist = useWatchlist(notify);
  // Quantas navegações internas existem para trás: "Voltar" nunca leva para fora do site.
  const inAppHistory = useRef(0);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onPop = () => {
      inAppHistory.current = Math.max(0, inAppHistory.current - 1);
      setRoute(parseLocation());
    };
    window.addEventListener("popstate", onPop);
    getJson("/health").then((health) => setMode(health.mode)).catch(() => setMode(null));
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = (path, next) => {
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      inAppHistory.current += 1;
    }
    setRoute(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const navigate = (view) => go(PATHS[view] ?? "/", { view });
  const details = (game) => game?.slug && go(`/jogos/${encodeURIComponent(game.slug)}`, { view: "detail", slug: game.slug });

  let page;
  if (route.view === "detail") page = <Detail slug={route.slug} onBack={() => (inAppHistory.current > 0 ? window.history.back() : navigate("home"))} onMethodology={() => setMethodology(true)} watchlist={watchlist} />;
  else if (route.view === "catalog") page = <Catalog search={search} onDetails={details} watchlist={watchlist} />;
  else if (route.view === "rankings") page = <Rankings onDetails={details} />;
  else if (route.view === "list") page = <MyList onDetails={details} watchlist={watchlist} onNavigate={navigate} />;
  else if (route.view === "status") page = <Status />;
  else page = <Home onDetails={details} onNavigate={navigate} onMethodology={() => setMethodology(true)} watchlist={watchlist} onMode={setMode} />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
      <Header view={route.view} onNavigate={navigate} search={search} setSearch={setSearch} mode={mode} listCount={watchlist.slugs.size} />
      {mode === "demo" && (
        <div className="demo-banner" role="note"><Warning size={16} /> Modo demonstração: a API está sem <code>DATABASE_URL</code> e mostra dados de exemplo.</div>
      )}
      <main id="conteudo">{page}</main>
      <footer>
        <span>SteamTwo</span><span>Dados públicos, rankings transparentes.</span>
        <button onClick={() => navigate("status")}>Status da integração</button>
        <button onClick={() => setMethodology(true)}>Metodologia</button>
      </footer>
      {methodology && <Methodology onClose={() => setMethodology(false)} />}
      {toast && <div className={`toast toast-${toast.tone}`} role="status" key={toast.id}>{toast.message}</div>}
    </div>
  );
}
