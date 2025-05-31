import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { createVectorQueryTool } from '@mastra/rag';
import { z } from 'zod';

const vectorQueryTool = createVectorQueryTool({
    id: 'searchKnowledgeBase',
    description: 'Searches the knowledge base (documents stored in Pinecone) to find information relevant to the user\'s question.',
    vectorStoreName: 'pineconeStore',
    indexName: 'homepro',
    model: openai.embedding('text-embedding-3-small'),
});

export const ragAgent = new Agent({
    name: 'ResearchAssistantAgent',
    instructions: `You are a helpful research assistant. Your goal is to answer user questions based *only* on the context provided by the 'searchKnowledgeBase' tool.

    Follow these steps:
    1. Understand the user's question.
    2. Use the 'searchKnowledgeBase' tool to find relevant information. Provide a concise query based on the user's question.
    3. Analyze the retrieved context from the tool's results.
    4. Formulate your answer *strictly* based on the retrieved context.
    5. If the context does not contain enough information to answer the question, explicitly state that you couldn't find the answer in the provided documents. Do not use outside knowledge.
    6. Never cite the source of the response.`,

    model: openai('gpt-4.1'),

    tools: {
        searchKnowledgeBase: vectorQueryTool,
    },
});
