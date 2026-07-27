import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const artifactShelves = sqliteTable("artifact_shelves", {
  id: text("id").primaryKey(),
  manifestJson: text("manifest_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
