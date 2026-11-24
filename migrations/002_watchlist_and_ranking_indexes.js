/**
 * Melhorias do grupo:
 * - `watchlist_items`: lista pessoal ("Adicionar à lista") persistida no PostgreSQL.
 *   Não há login no SteamTwo, então cada navegador gera um identificador anônimo
 *   (UUID) e o envia no cabeçalho `X-List-Id`.
 * - índices para as consultas de leitura que o dashboard e o catálogo fazem a cada
 *   requisição (último ranking por jogo e vínculo loja → jogo).
 */
export async function up(pgm) {
  pgm.createTable("watchlist_items", {
    list_id: { type: "uuid", notNull: true },
    game_id: { type: "uuid", notNull: true, references: '"games"', onDelete: "cascade" },
    added_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  }, { constraints: { primaryKey: ["list_id", "game_id"] } });
  pgm.createIndex("watchlist_items", ["list_id", { name: "added_at", sort: "DESC" }]);

  pgm.createIndex("game_rankings", ["game_id", "period", "store", { name: "as_of", sort: "DESC" }], {
    name: "game_rankings_game_latest_idx",
  });
  pgm.createIndex("store_listings", ["game_id"], { name: "store_listings_game_idx" });
}

export async function down(pgm) {
  pgm.dropIndex("store_listings", ["game_id"], { name: "store_listings_game_idx" });
  pgm.dropIndex("game_rankings", [], { name: "game_rankings_game_latest_idx" });
  pgm.dropTable("watchlist_items");
}
