export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LLMClient = {
  complete(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
};

const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

function requireKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  return key;
}

export function makeLLM(fetchImpl: typeof fetch = fetch): LLMClient {
  return {
    async complete(messages, opts = {}) {
      const apiKey = requireKey();
      const model = opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_CHAT_MODEL;
      const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: opts.temperature ?? 0.7,
          messages,
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`llm complete ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = (await res.json()) as { choices: { message: { content: string } }[] };
      return json.choices[0]?.message?.content ?? "";
    },
    async embed(texts: string[]) {
      const apiKey = requireKey();
      const model = process.env.OPENAI_EMBEDDINGS_MODEL ?? DEFAULT_EMBED_MODEL;
      const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`llm embed ${res.status}: ${detail.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      return json.data.map((d) => d.embedding);
    },
  };
}

export const llm: LLMClient = makeLLM();