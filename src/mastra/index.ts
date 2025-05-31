import { Mastra } from "@mastra/core";
import { createLogger } from "@mastra/core/logger";
import { PineconeVector } from "@mastra/pinecone";

import { ragAgent } from "./agents/ragAgent"; 
import { EliseAgent } from "./agents/agentElise";
import { nathanAgent } from "./agents/agentNathan";
import { lucyAgent } from "./agents/agentLucy"; 
import { jakeAgent } from "./agents/agentJake"; 
import { chloeAgent } from "./agents/agentChloe";
import { benAgent } from "./agents/agentBen";
import { alexAgent } from "./agents/agentAlex"; 

const pineconeApiKey = process.env.PINECONE_API_KEY;
const pineconeEnvironment = process.env.PINECONE_ENVIRONMENT;

if (!pineconeApiKey || !pineconeEnvironment) {
    // Added a console error for clarity before exiting
    console.error("Pinecone API Key or Environment not found in environment variables.");
    process.exit(1);
}

const pineconeStore = new PineconeVector(pineconeApiKey);

export const mastra = new Mastra({
  agents: {
    ragAgent, 
    EliseAgent,
    nathanAgent,
    lucyAgent,
    jakeAgent, 
    chloeAgent,
    benAgent,
    alexAgent, 
  },
  vectors: { pineconeStore },
  logger: createLogger({
    name: "MastraApp",
    level: "info",
  }),
});