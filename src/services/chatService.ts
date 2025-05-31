import { db } from "../db";
import { conversations, messages } from "../schema";
import { eq, asc, desc, sql, lt, and } from "drizzle-orm";
import crypto from "crypto";

/**
 * Fetch an existing conversation or create a brand-new one when the supplied id
 * is missing/invalid. Returns the Conversation record.
 */
export async function getOrCreateConversation(
  conversationId?: string | null,
  userId?: string | null
) {
  if (conversationId) {
    const existing = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (existing.length > 0) {
      return existing[0];
    }
  }

  const newConv = await db
    .insert(conversations)
    .values({ id: crypto.randomUUID(), userId })
    .returning();
  return newConv[0];
}

/**
 * Persist a single message for the given conversation.
 */
export async function saveMessage(
  conversationId: string,
  role: string,
  content: string
) {
  const inserted = await db
    .insert(messages)
    .values({ id: crypto.randomUUID(), conversationId, role, content })
    .returning();
  return inserted[0];
}

/**
 * Retrieve all messages for the specified conversation in chronological order.
 */
export async function getConversationHistory(
  conversationId: string,
  limit: number = 50,
  beforeMessageId?: string
) {
  try {
    let query = db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    // Add pagination support for older messages
    if (beforeMessageId) {
      const beforeMessage = await db
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.id, beforeMessageId))
        .limit(1);

      if (beforeMessage.length > 0) {
        if (beforeMessage[0].createdAt) {
          query = query.and(lt(messages.createdAt, beforeMessage[0].createdAt));
        }
      }
    }

    const result = await query
      .orderBy(desc(messages.createdAt)) // Get newest first for pagination
      .limit(limit);

    // Reverse to get chronological order
    return result.reverse();
  } catch (error) {
    console.error(
      `Error fetching conversation history for ${conversationId}:`,
      error
    );
    return [];
  }
}

/**
 * Get recent messages only (last 10) for faster initial load
 */
export async function getRecentMessages(
  conversationId: string,
  limit: number = 10
) {
  try {
    const result = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);

    return result.reverse(); // Return in chronological order
  } catch (error) {
    console.error(
      `Error fetching recent messages for ${conversationId}:`,
      error
    );
    return [];
  }
}

/**
 * Get conversation with message count for better UX
 */
export async function getConversationWithStats(conversationId: string) {
  try {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conversation) return null;

    const [messageCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    return {
      ...conversation,
      messageCount: messageCount?.count || 0,
    };
  } catch (error) {
    console.error(
      `Error fetching conversation stats for ${conversationId}:`,
      error
    );
    return null;
  }
}

/**
 * Get recent conversations with last message preview for faster loading
 */
export async function getConversationPreviews(userId?: string | null) {
  // Add a more efficient query that includes last message timestamp
  // and maybe the first few words of the last message
  const query = db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      title: conversations.title,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations);

  if (userId) {
    query.where(eq(conversations.userId, userId));
  }

  return query.orderBy(desc(conversations.updatedAt)).limit(20);
}

/**
 * List conversations for a given user (optionally filtered by userId).
 */
export async function listConversations(userId?: string | null) {
  if (userId) {
    return db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId));
  }
  return db.select().from(conversations);
}
