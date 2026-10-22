import { config } from "./config.js";

// Which embedding model and vector size a call uses: the configured one, or the old one while search still runs on it
// during a model change (#46).
export type EmbeddingModel = { model: string; dimensions: number };

export const configuredEmbedding = (): EmbeddingModel => ({ model: config.embeddingModel, dimensions: config.embeddingDimensions });

// A set of vectors is named by its model and size: the same model at another size is another set.
export const embeddingSetId = (target: EmbeddingModel) => `${target.model}@${target.dimensions}`;
