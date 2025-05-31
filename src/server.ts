import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import type { Request, Response } from "express";
import { ragAgent } from "./mastra/agents/ragAgent";

import { getOrCreateConversation, saveMessage, getConversationHistory, listConversations } from "./services/chatService";

interface CoreMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: unknown;
}

const app = express();
dotenv.config();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * POST /chat
 * Body: { messages: CoreMessage[], userId?: string|null, conversationId?: string|null, agentName?: string }
 * Streams assistant response back to the caller while persisting the full exchange.
 */
app.post("/chat", async (req: Request, res: Response) => {
  try {
    const { messages, userId, conversationId, agentName }: { messages: CoreMessage[]; userId?: string | null; conversationId?: string | null; agentName?: string } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== "user") {
      return res.status(400).json({ error: "Last message must be from user" });
    }

    // Create or retrieve conversation
    const conversation = await getOrCreateConversation(conversationId, userId ?? null);
    const convoId = conversation.id;

    // Save user message
    await saveMessage(convoId, lastMsg.role, lastMsg.content);

    // Prepare streaming headers
    res.setHeader("x-conversation-id", convoId);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    let assistantBuffer = "";

    // Select agent: default ragAgent or one from mastra.agents
    let agentToUse = ragAgent;
    if (agentName) {
      // Lazy import to avoid circular
      const { mastra } = await import("./mastra/index.js");
      const candidate = (mastra as any).getAgent?.(agentName) || (mastra as any)[agentName];
      if (candidate) agentToUse = candidate;
    }

    // Obtain streaming response from chosen agent
    const stream = await agentToUse.stream(messages as any);

    // Pipe each chunk to the HTTP response
    for await (const chunk of stream.textStream) {
      assistantBuffer += chunk;
      res.write(chunk);
    }

    // End HTTP response
    res.end();

    // Persist assistant answer after stream completes
    await saveMessage(convoId, "assistant", assistantBuffer);
  } catch (err: any) {
    console.error("/chat error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    } else {
      // Cannot modify headers; just close connection
      res.end();
    }
  }
});

/**
 * GET /history?conversationId=abc
 * Returns { messages: CoreMessage[] }
 */
app.get("/history", async (req: Request, res: Response) => {
  const conversationId = req.query.conversationId as string | undefined;
  if (!conversationId) {
    return res.status(400).json({ error: "conversationId is required" });
  }

  try {
    const msgs = await getConversationHistory(conversationId);
    const coreMsgs: CoreMessage[] = msgs.map((m: any) => ({ role: m.role, content: m.content }));
    return res.json({ messages: coreMsgs });
  } catch (err) {
    console.error("/history error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /conversations?userId=abc
 * Returns { conversations: [ { id, userId, title, createdAt, updatedAt } ] }
 */
app.get("/conversations", async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string | undefined;
    const convs = await listConversations(userId ?? null);
    return res.json({ conversations: convs });
  } catch (err) {
    console.error("/conversations error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
app.listen(PORT, () => {
  console.log(`HomePro Mastra API listening on port ${PORT}`);
}); 