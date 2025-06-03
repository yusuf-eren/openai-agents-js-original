/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
	OPENAI_API_KEY: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			const { Agent, run, setDefaultOpenAIKey, setTracingDisabled } = await import('@openai/agents');

			setDefaultOpenAIKey(env.OPENAI_API_KEY!);
			setTracingDisabled(true);

			const agent = new Agent({
				name: 'Test Agent',
				instructions: 'You will always only respond with "Hello there!". Not more not less.',
			});
			const result = await run(agent, 'Hey there!');
			return new Response(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
		} catch (error) {
			console.error(error);
			return new Response(String(error), { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
