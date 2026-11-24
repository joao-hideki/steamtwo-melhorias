import { requestJson } from "./http.js";
import { toSlug } from "./normalizers.js";

const APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const steamAsset = (appId, file) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${file}`;

function stripHtml(text) {
  return String(text ?? "").replace(/<[^>]*>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * Converte a resposta pública de `appdetails` no formato de catálogo usado pelos
 * jobs. Retorna null quando a Steam não tem dados para o app (success: false),
 * por exemplo apps removidos ou restritos por região.
 */
export function normalizeSteamAppDetails(appId, payload) {
  const entry = payload?.[String(appId)];
  if (!entry?.success || !entry.data?.name) return null;
  const { data } = entry;
  const title = stripHtml(data.name);
  return {
    source: "steam",
    externalId: String(appId),
    title,
    slug: toSlug(title) || `steam-${appId}`,
    summary: stripHtml(data.short_description) || null,
    coverUrl: steamAsset(appId, "library_600x900_2x.jpg"),
    heroUrl: steamAsset(appId, "library_hero.jpg"),
    // Sempre presente na resposta; usado quando a arte de biblioteca não existe no CDN.
    headerUrl: data.header_image || null,
    genres: (data.genres ?? []).map((genre) => ({ name: stripHtml(genre.description) })).filter((genre) => genre.name),
    releaseDate: null,
    stores: [{ store: "steam", externalId: String(appId), url: `https://store.steampowered.com/app/${appId}/` }],
  };
}

export function createSteamStoreClient({ language = "brazilian", countryCode = "BR", fetchImpl, delayMs = 350 } = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const doFetch = fetchImpl ?? globalThis.fetch;

  /** Jogos recentes não têm `library_600x900_2x.jpg`/`library_hero.jpg` no caminho padrão do CDN. */
  async function assetExists(url) {
    try {
      const response = await doFetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function getAppDetails(appId) {
    const url = new URL(APP_DETAILS_URL);
    url.searchParams.set("appids", String(appId));
    url.searchParams.set("l", language);
    url.searchParams.set("cc", countryCode);
    const payload = await requestJson(url, { service: "steam-store", fetchImpl });
    const game = normalizeSteamAppDetails(appId, payload);
    if (!game) return null;
    const { headerUrl, ...rest } = game;
    const [hasCover, hasHero] = await Promise.all([assetExists(game.coverUrl), assetExists(game.heroUrl)]);
    return {
      ...rest,
      coverUrl: hasCover ? game.coverUrl : headerUrl,
      heroUrl: hasHero ? game.heroUrl : headerUrl,
    };
  }

  return {
    getAppDetails,
    /** Busca em sequência (a loja limita ~200 requisições / 5 min). Falhas individuais não interrompem o lote. */
    async getManyAppDetails(appIds) {
      const games = [];
      const failures = [];
      for (const [index, appId] of appIds.entries()) {
        if (index > 0 && delayMs) await wait(delayMs);
        try {
          const game = await getAppDetails(appId);
          if (game) games.push(game);
          else failures.push({ appId, reason: "sem dados na loja" });
        } catch (error) {
          failures.push({ appId, reason: error.message });
        }
      }
      return { games, failures };
    },
  };
}
