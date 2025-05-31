import { pgTable, uuid, varchar, timestamp, json, text } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: varchar("user_id", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: false }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: false }).defaultNow(),
  title: varchar("title", { length: 255 }),
});

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull(),
  content: text("content").notNull(),
  name: varchar("name", { length: 255 }),
  toolCallId: varchar("tool_call_id", { length: 255 }),
  toolCalls: json("tool_calls"),
  metadata: json("metadata"),
  createdAt: timestamp("created_at", { withTimezone: false }).defaultNow(),
});

// Relation helpers (optional)
export const conversationRelations = relations(conversations, ({ many }: any) => ({
  messages: many(messages),
}));

export const messageRelations = relations(messages, ({ one }: any) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
})); 