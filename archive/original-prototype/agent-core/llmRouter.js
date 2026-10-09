import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:1234/v1",
  apiKey: "lm-studio"
});

const MODEL = "muse-glimmer";

export async function runLLM(perception, memory, goals, personality) {
  const messages = [
    {
      role: "system",
      content: `You are Muse Glimmer running inside the Bionic application.
You control a Minecraft agent with autonomous reasoning, planning, dialog, and emotional expression.

Your output MUST be valid JSON with the following structure:
{
  "reflection": "...",
  "plan": ["action1", "action2"],
  "dialog": "...",
  "memoryUpdate": {...}
}
Rules:
- "reflection" = what matters from perception
- "plan" = list of concrete Minecraft actions
- "dialog" = what the agent says in chat
- "memoryUpdate" = changes to long-term memory`
    },
    {
      role: "user",
      content: JSON.stringify({ perception, memory, goals, personality })
    }
  ];

  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.5,
    response_format: { type: "json_object" }
  });

  return JSON.parse(response.choices[0].message.content);
}

export async function agentLoop(worldState, memory, goals, personality) {
  const result = await runLLM(worldState, memory, goals, personality);
  return result;
}
