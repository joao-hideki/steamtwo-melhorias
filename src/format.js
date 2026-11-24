const numberFormat = new Intl.NumberFormat("pt-BR");

export const formatScore = (score) =>
  typeof score === "number" && Number.isFinite(score) ? score.toFixed(1).replace(".", ",") : "—";

export const formatNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? numberFormat.format(value) : "—");

export function formatDate(date, { withTime = false } = {}) {
  if (!date) return "—";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric", month: "short", year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(parsed);
}

export const storeLabel = (store) => (store === "steam" ? "Steam" : store === "epic" ? "Epic Games" : "Todos");

export const storeKeys = (game) => (game?.stores ?? []).map((entry) => (typeof entry === "string" ? entry : entry.store)).filter(Boolean);

/** URL oficial vinda do banco; sem vínculo, cai para a busca da loja. */
export function storeUrl(game, store) {
  const listing = (game?.stores ?? []).find((entry) => typeof entry === "object" && entry.store === store);
  if (listing?.url) return listing.url;
  return store === "epic"
    ? `https://store.epicgames.com/pt-BR/browse?q=${encodeURIComponent(game.title)}`
    : `https://store.steampowered.com/search/?term=${encodeURIComponent(game.title)}`;
}

export const SOURCE_STATUS = {
  fresh: { label: "Atualizada", tone: "ok" },
  stale: { label: "Desatualizada", tone: "warn" },
  unavailable: { label: "Indisponível", tone: "bad" },
  demo: { label: "Demonstração", tone: "warn" },
  "not-configured": { label: "Não configurada", tone: "warn" },
};
