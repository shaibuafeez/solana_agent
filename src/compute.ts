/**
 * Groq API — AI inference for trading decisions
 * OpenAI-compatible endpoint at https://api.groq.com/openai/v1
 */

import type { AppConfig, Message } from './types.js';

const BASE_URL = 'https://api.groq.com/openai/v1';

/**
 * Non-streaming chat completion — returns full text response.
 * Used for trading decisions where we need the complete JSON.
 */
export async function chatCompletion(
  config: AppConfig,
  messages: Message[],
  systemPrompt?: string
): Promise<{ text: string; model: string }> {
  if (!config.grokApiKey) {
    throw new Error('Groq API key not set. Run: solana-agent config set grokApiKey <key>');
  }

  const body = {
    model: config.grokModel,
    stream: false,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.grokApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Groq API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  const text = data.choices?.[0]?.message?.content || '';
  return { text, model: data.model || config.grokModel };
}
