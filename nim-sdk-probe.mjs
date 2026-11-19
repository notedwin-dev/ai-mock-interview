import 'dotenv/config';
import { generateText, Output } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
const provider = createOpenAICompatible({ name: 'nim', baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: process.env.NVIDIA_API_KEY });
const model = provider.chatModel('moonshotai/kimi-k3.1-pro');
for (const [label, options] of [
  ['default', {}],
  ['maxTokens2048', { maxOutputTokens: 2048 }],
  ['no-structured', { output: undefined }],
]) {
  try {
    const args = { model, prompt: 'Return a JSON object with a short greeting field.', maxRetries: 0, ...options };
    if (label !== 'no-structured') args.output = Output.object({ schema: z.object({ greeting: z.string() }) });
    const r = await generateText(args);
    console.log(label + ': ok', JSON.stringify(r.output ?? r.text).slice(0, 200));
  } catch (e) {
    console.log(label + ': ' + e.name + ' | ' + String(e.message).slice(0, 200) + ' | cause=' + String(e.cause?.message ?? '').slice(0, 200));
  }
}