// Provider-agnostic LLM client using fetch only (no SDK dependency).
// Supports OpenAI, Anthropic, and any OpenAI-compatible endpoint.
// When no API key is set it runs in OFFLINE mode and returns deterministic
// placeholder text so the whole pipeline can be exercised without spending money.
import { config } from "./config.js";

export const isOffline = () => !config.llm.apiKey;

interface ChatOpts {
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export async function chat(prompt: string, opts: ChatOpts = {}): Promise<string> {
  if (isOffline()) return offlineAnswer(prompt);

  const { provider, apiKey, model, baseUrl } = config.llm;
  const temperature = opts.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? 2000;

  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: opts.system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return j.content?.map((c: any) => c.text).join("") ?? "";
  }

  // openai / openai-compatible
  const url = (baseUrl || "https://api.openai.com/v1").replace(/\/$/, "") + "/chat/completions";
  const messages = [
    ...(opts.system ? [{ role: "system", content: opts.system }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  return j.choices?.[0]?.message?.content ?? "";
}

// Deterministic offline placeholder so the pipeline is runnable end-to-end.
function offlineAnswer(prompt: string): string {
  const topic = (prompt.match(/TOPIC:\s*(.+)/)?.[1] ?? "the topic").trim();
  return [
    `## Quick answer`,
    `If you are short on time, our top pick for ${topic} is the option with the best balance of price, features and support. Below we explain why.`,
    ``,
    `## Why this matters`,
    `Choosing the right tool for ${topic} saves hours every week and avoids costly switching later. We compared the leading options on price, ease of use, integrations and support.`,
    ``,
    `## What we looked at`,
    `We weighted real-world usability over feature checklists. A tool that you actually use beats a bloated one you abandon.`,
    ``,
    `## The short list`,
    `Each option below fits a slightly different user. Match the pick to your situation rather than chasing the "best overall".`,
    ``,
    `## Frequently asked questions`,
    `**Is there a free plan?** Several options offer free tiers suitable for getting started.`,
    `**Can I switch later?** Yes, most tools let you export your data.`,
    ``,
    `## Bottom line`,
    `For most people evaluating ${topic}, start with the top pick, use the free trial, and upgrade only once it proves its value.`,
    `[OFFLINE PLACEHOLDER — set LLM_API_KEY to generate real content.]`,
  ].join("\n");
}
