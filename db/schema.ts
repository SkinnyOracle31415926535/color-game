import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Owner-scoped semantic records used by private device sync. */
export const appSyncRecords = sqliteTable("app_sync_records", {
  ownerId: text("owner_id").notNull(),
  appId: text("app_id").notNull(),
  collectionName: text("collection_name").notNull(),
  recordId: text("record_id").notNull(),
  revision: integer("revision").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.appId, table.collectionName, table.recordId] }),
]);
