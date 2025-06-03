import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { openai } from '@ai-sdk/openai';
import { aisdk } from '@openai/agents-extensions';

const model = aisdk(openai('gpt-4.1-nano'));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    demo: z.string(),
  }),
  execute: async (input) => {
    await sleep(300);
    return `The weather in ${input.demo} is sunny`;
  },
});

const dataAgentTwo = new Agent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  handoffDescription: 'You know everything about the weather',
  tools: [getWeatherTool],
  model, // Using the AI SDK model for this agent
});

const agent = new Agent({
  name: 'Basic test agent',
  instructions: 'You are a basic agent',
  handoffs: [dataAgentTwo],
});

async function main() {
  const result = await run(
    agent,
    'Hello what is the weather in San Francisco and oakland?',
  );

  console.log(result.finalOutput);
}

main();
