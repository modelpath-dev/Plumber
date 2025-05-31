// --- Environment Variable Loading (Keep this at the VERY TOP) ---
import dotenv from 'dotenv';
dotenv.config();
// --- End Environment Variable Loading ---

// --- Mastra Core/Component Imports ---
import { Mastra } from "@mastra/core";
import { PineconeVector } from "@mastra/pinecone"; // <--- Changed Import
import { MDocument } from "@mastra/rag";
import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";

// --- Node Built-in Imports ---
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'node:url';

// --- PDF Parsing Import (using pdfjs-dist) ---
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
let workerSrcPath;
try {
    workerSrcPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
} catch (e) {
    console.warn("Could not use require.resolve for pdf.worker.mjs, using relative path. Ensure node_modules structure is standard.");
    workerSrcPath = path.resolve(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
}
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerSrcPath).toString();
// --- End PDF Worker Path Fix ---

// --- Configuration ---
const KNOWLEDGE_DIR = path.resolve(process.cwd(), 'Knowledge');
const INDEX_NAME = "homepro"; // Pinecone index name (must be DNS compliant: lowercase, nums, hyphens)
const EMBEDDING_MODEL = openai.embedding("text-embedding-3-small");
const DIMENSION = 1536;
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 50;
const VECTOR_STORE_NAME = "pineconeKnowledge"; // Name for Mastra registration
const EMBEDDING_BATCH_SIZE = 100;
const UPSERT_BATCH_SIZE = 100; // Pinecone has limits, batching upserts is good practice
// --- End Configuration ---

// --- Helper Functions (extractAgentName, extractTextFromPdf, processPdfFile) ---
function extractAgentName(filename: string): string | null {
    const match = filename.match(/.*?-([A-Z]+)\.pdf$/i);
    return match ? match[1].toUpperCase() : null;
}

async function extractTextFromPdf(filePath: string): Promise<{ text: string; numPages: number } | null> {
    let pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
    try {
        const data = new Uint8Array(await fs.readFile(filePath));
        const loadingTask = pdfjsLib.getDocument({ data });
        pdfDocument = await loadingTask.promise;
        let fullText = '';
        for (let i = 1; i <= pdfDocument.numPages; i++) {
            try {
                const page = await pdfDocument.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items
                    .map(item => ('str' in item ? item.str : ''))
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                fullText += pageText + '\n\n';
                page.cleanup();
            } catch (pageError: any) {
                 console.warn(`   - Warning: Could not extract text from page ${i} of ${path.basename(filePath)}: ${pageError.message}`);
            }
        }
        fullText = fullText.trim();
        return { text: fullText, numPages: pdfDocument.numPages };
    } catch (error: any) {
        console.error(`  - Error extracting text from PDF ${path.basename(filePath)}: ${error.message || error}`);
        return null;
    } finally {
         if (pdfDocument) {
             try {
                 await pdfDocument.destroy();
             } catch (destroyError) {
                  console.warn(`  - Warning: Failed to destroy PDF document object for ${path.basename(filePath)}:`, destroyError)
             }
         }
    }
}

async function processPdfFile(filePath: string): Promise<any[]> {
     const filename = path.basename(filePath);
     console.log(`-> Processing: ${filename}`);
     try {
         const pdfResult = await extractTextFromPdf(filePath);
         if (!pdfResult) return [];

         const { text: extractedText, numPages } = pdfResult;
         console.log(`  - Successfully extracted text from ${filename} (${numPages} pages)`);

         const agentName = extractAgentName(filename);
         if (!agentName) {
             console.warn(`  - Could not extract agent name from filename: ${filename}. 'agentName' metadata will be null.`);
         }
         if (!extractedText || extractedText.trim() === '') {
             console.warn(`  - No text content extracted from ${filename}. Skipping file.`);
             return [];
         }

         const doc = MDocument.fromText(extractedText);
         const chunks = await doc.chunk({ strategy: "recursive", size: CHUNK_SIZE, overlap: CHUNK_OVERLAP });

         const chunksWithMetadata = chunks.map((chunk, index) => ({
             id: `${filename}_chunk_${index}`, // Generate a unique ID for Pinecone
             ...chunk,
             metadata: {
                 ...chunk.metadata,
                 text: chunk.text, // Pinecone needs text in metadata for retrieval display
                 source: filename,
                 chunkIndex: index,
                 agentName: agentName,
             }
         }));
         console.log(`  - Generated ${chunksWithMetadata.length} chunks.`);
         return chunksWithMetadata;
     } catch (error: any) {
         console.error(`  - Error processing file ${filename} (chunking/metadata): ${error.message || error}`);
         return [];
     }
}
// --- End Helper Functions ---

/**
 * Main function to load all PDFs, embed, and upsert.
 */
async function loadKnowledgeBase() {
    // --- Initialize Mastra and Vector Store ---
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    const pineconeEnvironment = process.env.PINECONE_ENVIRONMENT;

    if (!pineconeApiKey || !pineconeEnvironment) {
        console.error("Error: PINECONE_API_KEY and PINECONE_ENVIRONMENT must be defined in your .env file.");
        process.exit(1);
    }

    // --- Use the PineconeVector constructor ---
    // Assuming the constructor expects the API key directly and handles environment implicitly or via other means
    const pineconeStore = new PineconeVector(pineconeApiKey);
    // Note: If environment needs explicit setting, check the library's documentation for the correct method.
    // --- End PineconeVector constructor ---

    const mastraInstance = new Mastra({
        vectors: { [VECTOR_STORE_NAME]: pineconeStore },
    });
    // --- End Initialization ---

    console.log(`\nStarting knowledge base loading from directory: ${KNOWLEDGE_DIR}`);
    let allChunks: any[] = [];
    let pineconeVector: PineconeVector | undefined; // Keep reference

    try {
        pineconeVector = mastraInstance.getVector(VECTOR_STORE_NAME) as PineconeVector;
        if (!pineconeVector) {
            console.error(`Vector store named '${VECTOR_STORE_NAME}' not found.`);
            return;
        }

        // Check if Pinecone index exists, create if not
        console.log(`Checking Pinecone index '${INDEX_NAME}'...`);
        const indexes = await pineconeVector.listIndexes();
        if (!indexes.includes(INDEX_NAME)) {
            console.log(`Index '${INDEX_NAME}' does not exist. Creating...`);
            try {
                await pineconeVector.createIndex({
                    indexName: INDEX_NAME,
                    dimension: DIMENSION,
                    metric: "cosine",
                });
                console.log(`Index '${INDEX_NAME}' created. Waiting a moment for it to initialize...`);
                // Pinecone indexes can take a short while to become available
                await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds (adjust if needed)
            } catch (error: any) {
                console.error(`Failed to create index '${INDEX_NAME}': ${error.message || error}`);
                return;
            }
        } else {
            console.log(`Index '${INDEX_NAME}' already exists.`);
            // Optional: Verify dimension/metric if needed via describeIndex
            // const stats = await pineconeVector.describeIndex(INDEX_NAME);
            // if (stats.dimension !== DIMENSION || stats.metric !== 'cosine') {
            //     console.error(`Index '${INDEX_NAME}' exists but has wrong configuration.`);
            //     return;
            // }
        }

        const files = await fs.readdir(KNOWLEDGE_DIR);
        const pdfFiles = files.filter(file => path.extname(file).toLowerCase() === '.pdf');
        console.log(`Found ${pdfFiles.length} PDF files.`);
        if (pdfFiles.length === 0) {
             console.error(`No PDF files found in directory: ${KNOWLEDGE_DIR}`);
             return;
        }

        for (const file of pdfFiles) {
            const filePath = path.join(KNOWLEDGE_DIR, file);
            // File existence check removed for brevity as readdir already ensures they exist
            const fileChunks = await processPdfFile(filePath);
            allChunks = allChunks.concat(fileChunks);
        }

        console.log(`\nTotal chunks generated from all valid PDF files: ${allChunks.length}`);
        if (allChunks.length === 0) {
            console.log("No chunks were generated. Exiting.");
            return;
        }

        // --- Generate Embeddings ---
        console.log("Generating embeddings...");
        const chunkTexts = allChunks.map((chunk) => chunk.text);
        let allEmbeddings: number[][] = [];
        for (let i = 0; i < chunkTexts.length; i += EMBEDDING_BATCH_SIZE) {
            const batch = chunkTexts.slice(i, i + EMBEDDING_BATCH_SIZE);
            console.log(`  - Generating embeddings batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(chunkTexts.length / EMBEDDING_BATCH_SIZE)} (size ${batch.length})...`);
            try {
                const { embeddings: batchEmbeddings } = await embedMany({ model: EMBEDDING_MODEL, values: batch });
                if (batchEmbeddings.length !== batch.length) throw new Error(`Embedding count mismatch`);
                allEmbeddings = allEmbeddings.concat(batchEmbeddings);
            } catch (error: any) {
                console.error(`  - Error generating embeddings batch: ${error.message || error}. Aborting.`);
                return;
            }
        }
        console.log(`Generated total ${allEmbeddings.length} embeddings.`);
        if (allEmbeddings.length !== allChunks.length) {
            console.error("CRITICAL: Mismatch between chunks and embeddings. Aborting upsert.");
            return;
        }

        // --- Prepare Data for Pinecone Upsert ---
        // Pinecone expects an array of objects with id, values (embedding), and metadata
        const vectorsToUpsert = allChunks.map((chunk, i) => ({
            id: chunk.id, // Use the generated ID from processPdfFile
            values: allEmbeddings[i],
            metadata: chunk.metadata,
        }));

        // --- Upsert Data ---
        console.log(`Upserting ${vectorsToUpsert.length} vectors into index '${INDEX_NAME}'...`);
         try {
             for (let i = 0; i < vectorsToUpsert.length; i += UPSERT_BATCH_SIZE) {
                  const batch = vectorsToUpsert.slice(i, i + UPSERT_BATCH_SIZE);
                  console.log(`  - Upserting batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}/${Math.ceil(vectorsToUpsert.length / UPSERT_BATCH_SIZE)} (size ${batch.length})...`);
                  // The @mastra/pinecone upsert expects slightly different format than Pinecone client directly
                  await pineconeVector.upsert({
                      indexName: INDEX_NAME,
                      vectors: batch.map(v => v.values), // Extract just the vectors
                      metadata: batch.map(v => v.metadata), // Extract just the metadata
                      ids: batch.map(v => v.id) // Extract just the ids
                  });
             }
             console.log("Upsert complete!");
         } catch (error: any) {
             console.error(`Failed to upsert data into index '${INDEX_NAME}': ${error.message || error}`);
              // Log more details if available from Pinecone error
              if (error.cause) {
                  console.error("Cause:", error.cause);
              }
             return;
         }

        // --- Optional Verification ---
        console.log("Verifying upsert with a sample query...");
         try {
             const { embedding: queryEmbedding } = await embed({ model: EMBEDDING_MODEL, value: "What is pricebook?" });
             const results = await pineconeVector.query({
                 indexName: INDEX_NAME,
                 queryVector: queryEmbedding,
                 topK: 3,
                 filter: { agentName: "LUCY" }, // Filter by agent name
                 includeVector: false, // Typically false for verification
                 // namespace: "your-namespace" // Add if using namespaces
             });
             console.log("\n--- Sample Query Results (Agent: LUCY) ---");
             if (results.length > 0) {
                  results.forEach((res, i) => {
                       console.log(`Result ${i+1}: Score: ${res.score.toFixed(4)}, ID: ${res.id}`);
                       console.log(`  Metadata: Source: ${res.metadata?.source}, Agent: ${res.metadata?.agentName}, Chunk: ${res.metadata?.chunkIndex}`);
                       console.log(`  Text: ${res.metadata?.text?.substring(0, 150)?.replace(/\n/g, ' ')}...`);
                  })
                 console.log("-----------------------------------------\nSuccessfully retrieved results.");
             } else {
                 console.warn("Verification query returned no results.");
             }
         } catch (error: any) {
             console.error("Error during verification query:", error.message || error);
         }

    } catch (error: any) {
        console.error(`Error during knowledge base loading: ${error.message || error}`);
    } finally {
        // Pinecone client doesn't require explicit disconnect like pg pool
        console.log("Pinecone operations finished.");
    }
}

// Run the main function
loadKnowledgeBase()
    .then(() => console.log("\nKnowledge base loading script finished."))
    .catch(err => console.error("\nUnhandled error in loadKnowledgeBase:", err));