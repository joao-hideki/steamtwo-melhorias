/** Cliente HTTP da interface. Toda leitura passa pela API (que lê o PostgreSQL). */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = "GET", signal, headers = {} } = {}) {
  const response = await fetch(`/api${path}`, { method, signal, headers: { Accept: "application/json", ...headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error || `Erro ${response.status}`, response.status);
  return payload;
}

export const getJson = (path, options) => request(path, options);

export function query(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "" && value !== "all") search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : "";
}

const LIST_KEY = "steamtwo:list-id";
let memoryListId = null;

/**
 * Identificador anônimo da lista pessoal. Fica no localStorage do navegador;
 * se o armazenamento estiver bloqueado, vale apenas para esta aba.
 */
export function getListId() {
  try {
    let id = window.localStorage.getItem(LIST_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(LIST_KEY, id);
    }
    return id;
  } catch {
    memoryListId ??= crypto.randomUUID();
    return memoryListId;
  }
}

const listHeaders = () => ({ "X-List-Id": getListId() });

export const listApi = {
  items: (signal) => request("/list", { signal, headers: listHeaders() }),
  add: (slug) => request(`/list/${encodeURIComponent(slug)}`, { method: "PUT", headers: listHeaders() }),
  remove: (slug) => request(`/list/${encodeURIComponent(slug)}`, { method: "DELETE", headers: listHeaders() }),
};
