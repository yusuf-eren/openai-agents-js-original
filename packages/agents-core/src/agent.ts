import type { ZodObject } from 'zod';

import type { InputGuardrail, OutputGuardrail } from './guardrail';
import { AgentHooks } from './lifecycle';
import { getAllMcpTools, type MCPServer } from './mcp';
import type { Model, ModelSettings, Prompt } from './model';
import {
  getDefaultModelSettings,
  gpt5ReasoningSettingsRequired,
  isGpt5Default,
} from './defaultModel';
import type { RunContext } from './runContext';
import {
  type FunctionTool,
  type FunctionToolResult,
  tool,
  type Tool,
} from './tool';
import type {
  ResolvedAgentOutput,
  JsonSchemaDefinition,
  HandoffsOutput,
  Expand,
} from './types';
import type { RunResult } from './result';
import type { Handoff } from './handoff';
import { Runner } from './run';
import { toFunctionToolName } from './utils/tools';
import { getOutputText } from './utils/messages';
import { isAgentToolInput } from './utils/typeGuards';
import { isZodObject } from './utils/typeGuards';
import { ModelBehaviorError, UserError } from './errors';
import { RunToolApprovalItem } from './items';
import logger from './logger';
import { UnknownContext, TextOutput } from './types';

export type ToolUseBehaviorFlags = 'run_llm_again' | 'stop_on_first_tool';

export type ToolsToFinalOutputResult =
  | {
      /**
       * Whether this is the final output. If `false`, the LLM will run again and receive the tool call output
       */
      isFinalOutput: false;
      /**
       * Whether the agent was interrupted by a tool approval. If `true`, the LLM will run again and receive the tool call output
       */
      isInterrupted: undefined;
    }
  | {
      isFinalOutput: false;
      /**
       * Whether the agent was interrupted by a tool approval. If `true`, the LLM will run again and receive the tool call output
       */
      isInterrupted: true;
      interruptions: RunToolApprovalItem[];
    }
  | {
      /**
       * Whether this is the final output. If `false`, the LLM will run again and receive the tool call output
       */
      isFinalOutput: true;

      /**
       * Whether the agent was interrupted by a tool approval. If `true`, the LLM will run again and receive the tool call output
       */
      isInterrupted: undefined;

      /**
       * The final output. Can be undefined if `isFinalOutput` is `false`, otherwise it must be a string
       * that will be processed based on the `outputType` of the agent.
       */
      finalOutput: string;
    };

/**
 * The type of the output object. If not provided, the output will be a string.
 * 'text' is a special type that indicates the output will be a string.
 *
 * @template HandoffOutputType The type of the output of the handoff.
 */
export type AgentOutputType<HandoffOutputType = UnknownContext> =
  | TextOutput
  | ZodObject<any>
  | JsonSchemaDefinition
  | HandoffsOutput<HandoffOutputType>;

/**
 * A function that takes a run context and a list of tool results and returns a `ToolsToFinalOutputResult`.
 */
export type ToolToFinalOutputFunction = (
  context: RunContext,
  toolResults: FunctionToolResult[],
) => ToolsToFinalOutputResult | Promise<ToolsToFinalOutputResult>;

/**
 * The behavior of the agent when a tool is called.
 */
export type ToolUseBehavior =
  | ToolUseBehaviorFlags
  | {
      /**
       * List of tool names that will stop the agent from running further. The final output will be
       * the output of the first tool in the list that was called.
       */
      stopAtToolNames: string[];
    }
  | ToolToFinalOutputFunction;

/**
 * Configuration for an agent.
 *
 * @template TContext The type of the context object.
 * @template TOutput The type of the output object.
 */
export interface AgentConfiguration<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> {
  /**
   * The name of the agent.
   */
  name: string;

  /**
   * The instructions for the agent. Will be used as the "system prompt" when this agent is
   * invoked. Describes what the agent should do, and how it responds.
   *
   * Can either be a string, or a function that dynamically generates instructions for the agent.
   * If you provide a function, it will be called with the context and the agent instance. It
   * must return a string.
   */
  instructions:
    | string
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<string> | string);

  /**
   * The prompt template to use for the agent (OpenAI Responses API only).
   *
   * Can either be a prompt template object, or a function that returns a prompt
   * template object. If a function is provided, it will be called with the run
   * context and the agent instance. It must return a prompt template object.
   */
  prompt?:
    | Prompt
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<Prompt> | Prompt);

  /**
   * A description of the agent. This is used when the agent is used as a handoff, so that an LLM
   * knows what it does and when to invoke it.
   */
  handoffDescription: string;

  /**
   * Handoffs are sub-agents that the agent can delegate to. You can provide a list of handoffs,
   * and the agent can choose to delegate to them if relevant. Allows for separation of concerns
   * and modularity.
   */
  handoffs: (Agent<any, any> | Handoff<any, TOutput>)[];

  /**
   * The warning log would be enabled when multiple output types by handoff agents are detected.
   */
  handoffOutputTypeWarningEnabled?: boolean;

  /**
   * The model implementation to use when invoking the LLM.
   *
   * By default, if not set, the agent will use the default model returned by
   * getDefaultModel (currently "gpt-4.1").
   */
  model: string | Model;

  /**
   * Configures model-specific tuning parameters (e.g. temperature, top_p, etc.)
   */
  modelSettings: ModelSettings;

  /**
   * A list of tools the agent can use.
   */
  tools: Tool<TContext>[];

  /**
   * A list of [Model Context Protocol](https://modelcontextprotocol.io/) servers the agent can use.
   * Every time the agent runs, it will include tools from these servers in the list of available
   * tools.
   *
   * NOTE: You are expected to manage the lifecycle of these servers. Specifically, you must call
   * `server.connect()` before passing it to the agent, and `server.cleanup()` when the server is
   * no longer needed.
   */
  mcpServers: MCPServer[];

  /**
   * A list of checks that run in parallel to the agent's execution, before generating a response.
   * Runs only if the agent is the first agent in the chain.
   */
  inputGuardrails: InputGuardrail[];

  /**
   * A list of checks that run on the final output of the agent, after generating a response. Runs
   * only if the agent produces a final output.
   */
  outputGuardrails: OutputGuardrail<TOutput>[];

  /**
   * The type of the output object. If not provided, the output will be a string.
   */
  outputType: TOutput;

  /**
   * This lets you configure how tool use is handled.
   * - run_llm_again: The default behavior. Tools are run, and then the LLM receives the results
   *   and gets to respond.
   * - stop_on_first_tool: The output of the first tool call is used as the final output. This means
   *   that the LLM does not process the result of the tool call.
   * - A list of tool names: The agent will stop running if any of the tools in the list are called.
   *   The final output will be the output of the first matching tool call. The LLM does not process
   *   the result of the tool call.
   * - A function: if you pass a function, it will be called with the run context and the list of
   *   tool results. It must return a `ToolsToFinalOutputResult`, which determines whether the tool
   *   call resulted in a final output.
   *
   * NOTE: This configuration is specific to `FunctionTools`. Hosted tools, such as file search, web
   * search, etc. are always processed by the LLM
   */
  toolUseBehavior: ToolUseBehavior;

  /**
   * Whether to reset the tool choice to the default value after a tool has been called. Defaults
   * to `true`. This ensures that the agent doesn't enter an infinite loop of tool usage.
   */
  resetToolChoice: boolean;
}

export type AgentOptions<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> = Expand<
  Pick<AgentConfiguration<TContext, TOutput>, 'name'> &
    Partial<AgentConfiguration<TContext, TOutput>>
>;

/**
 * An agent is an AI model configured with instructions, tools, guardrails, handoffs and more.
 *
 * We strongly recommend passing `instructions`, which is the "system prompt" for the agent. In
 * addition, you can pass `handoffDescription`, which is a human-readable description of the
 * agent, used when the agent is used inside tools/handoffs.
 *
 * Agents are generic on the context type. The context is a (mutable) object you create. It is
 * passed to tool functions, handoffs, guardrails, etc.
 */
// --- Type utilities for inferring output type from handoffs ---
type ExtractAgentOutput<T> = T extends Agent<any, infer O> ? O : never;
type ExtractHandoffOutput<T> = T extends Handoff<any, infer O> ? O : never;
export type HandoffsOutputUnion<
  Handoffs extends readonly (Agent<any, any> | Handoff<any, any>)[],
> =
  | ExtractAgentOutput<Handoffs[number]>
  | ExtractHandoffOutput<Handoffs[number]>;

/**
 * Helper type for config with handoffs
 *
 * @template TOutput The type of the output object.
 * @template Handoffs The type of the handoffs.
 */
export type AgentConfigWithHandoffs<
  TOutput extends AgentOutputType,
  Handoffs extends readonly (Agent<any, any> | Handoff<any, any>)[],
> = { name: string; handoffs?: Handoffs; outputType?: TOutput } & Partial<
  Omit<
    AgentConfiguration<UnknownContext, TOutput | HandoffsOutputUnion<Handoffs>>,
    'name' | 'handoffs' | 'outputType'
  >
>;

/**
 * The class representing an AI agent configured with instructions, tools, guardrails, handoffs and more.
 *
 * We strongly recommend passing `instructions`, which is the "system prompt" for the agent. In
 * addition, you can pass `handoffDescription`, which is a human-readable description of the
 * agent, used when the agent is used inside tools/handoffs.
 *
 * Agents are generic on the context type. The context is a (mutable) object you create. It is
 * passed to tool functions, handoffs, guardrails, etc.
 */
export class Agent<
    TContext = UnknownContext,
    TOutput extends AgentOutputType = TextOutput,
  >
  extends AgentHooks<TContext, TOutput>
  implements AgentConfiguration<TContext, TOutput>
{
  /**
   * Create an Agent with handoffs and automatically infer the union type for TOutput from the handoff agents' output types.
   */
  static create<
    TOutput extends AgentOutputType = TextOutput,
    Handoffs extends readonly (Agent<any, any> | Handoff<any, any>)[] = [],
  >(
    config: AgentConfigWithHandoffs<TOutput, Handoffs>,
  ): Agent<UnknownContext, TOutput | HandoffsOutputUnion<Handoffs>> {
    return new Agent<UnknownContext, TOutput | HandoffsOutputUnion<Handoffs>>({
      ...config,
      handoffs: config.handoffs as any,
      outputType: config.outputType,
      handoffOutputTypeWarningEnabled: false,
    });
  }

  static DEFAULT_MODEL_PLACEHOLDER = '';

  name: string;
  instructions:
    | string
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<string> | string);
  prompt?:
    | Prompt
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<Prompt> | Prompt);
  handoffDescription: string;
  handoffs: (Agent<any, TOutput> | Handoff<any, TOutput>)[];
  model: string | Model;
  modelSettings: ModelSettings;
  tools: Tool<TContext>[];
  mcpServers: MCPServer[];
  inputGuardrails: InputGuardrail[];
  outputGuardrails: OutputGuardrail<AgentOutputType>[];
  outputType: TOutput = 'text' as TOutput;
  toolUseBehavior: ToolUseBehavior;
  resetToolChoice: boolean;

  constructor(config: AgentOptions<TContext, TOutput>) {
    super();
    if (typeof config.name !== 'string' || config.name.trim() === '') {
      throw new UserError('Agent must have a name.');
    }
    this.name = config.name;
    this.instructions = config.instructions ?? Agent.DEFAULT_MODEL_PLACEHOLDER;
    this.prompt = config.prompt;
    this.handoffDescription = config.handoffDescription ?? '';
    this.handoffs = config.handoffs ?? [];
    this.model = config.model ?? '';
    this.modelSettings = config.modelSettings ?? getDefaultModelSettings();
    this.tools = config.tools ?? [];
    this.mcpServers = config.mcpServers ?? [];
    this.inputGuardrails = config.inputGuardrails ?? [];
    this.outputGuardrails = config.outputGuardrails ?? [];
    if (config.outputType) {
      this.outputType = config.outputType;
    }
    this.toolUseBehavior = config.toolUseBehavior ?? 'run_llm_again';
    this.resetToolChoice = config.resetToolChoice ?? true;

    if (
      // The user sets a non-default model
      config.model !== undefined &&
      // The default model is gpt-5
      isGpt5Default() &&
      // However, the specified model is not a gpt-5 model
      (typeof config.model !== 'string' ||
        !gpt5ReasoningSettingsRequired(config.model)) &&
      // The model settings are not customized for the specified model
      config.modelSettings === undefined
    ) {
      // In this scenario, we should use a generic model settings
      // because non-gpt-5 models are not compatible with the default gpt-5 model settings.
      // This is a best-effort attempt to make the agent work with non-gpt-5 models.
      this.modelSettings = {};
    }

    // --- Runtime warning for handoff output type compatibility ---
    if (
      config.handoffOutputTypeWarningEnabled === undefined ||
      config.handoffOutputTypeWarningEnabled
    ) {
      if (this.handoffs && this.outputType) {
        const outputTypes = new Set<string>([JSON.stringify(this.outputType)]);
        for (const h of this.handoffs) {
          if ('outputType' in h && h.outputType) {
            outputTypes.add(JSON.stringify(h.outputType));
          } else if ('agent' in h && h.agent.outputType) {
            outputTypes.add(JSON.stringify(h.agent.outputType));
          }
        }
        if (outputTypes.size > 1) {
          logger.warn(
            `[Agent] Warning: Handoff agents have different output types: ${Array.from(outputTypes).join(', ')}. You can make it type-safe by using Agent.create({ ... }) method instead.`,
          );
        }
      }
    }
  }

  /**
   * Output schema name.
   */
  get outputSchemaName(): string {
    if (this.outputType === 'text') {
      return 'text';
    } else if (isZodObject(this.outputType)) {
      return 'ZodOutput';
    } else if (typeof this.outputType === 'object') {
      return this.outputType.name;
    }

    throw new Error(`Unknown output type: ${this.outputType}`);
  }

  /**
   * Makes a copy of the agent, with the given arguments changed. For example, you could do:
   *
   * ```
   * const newAgent = agent.clone({ instructions: 'New instructions' })
   * ```
   *
   * @param config - A partial configuration to change.
   * @returns A new agent with the given changes.
   */
  clone(
    config: Partial<AgentConfiguration<TContext, TOutput>>,
  ): Agent<TContext, TOutput> {
    return new Agent({
      ...this,
      ...config,
    });
  }

  /**
   * Transform this agent into a tool, callable by other agents.
   *
   * This is different from handoffs in two ways:
   * 1. In handoffs, the new agent receives the conversation history. In this tool, the new agent
   *    receives generated input.
   * 2. In handoffs, the new agent takes over the conversation. In this tool, the new agent is
   *    called as a tool, and the conversation is continued by the original agent.
   *
   * @param options - Options for the tool.
   * @returns A tool that runs the agent and returns the output text.
   */
  asTool(options: {
    /**
     * The name of the tool. If not provided, the name of the agent will be used.
     */
    toolName?: string;
    /**
     * The description of the tool, which should indicate what the tool does and when to use it.
     */
    toolDescription?: string;
    /**
     * A function that extracts the output text from the agent. If not provided, the last message
     * from the agent will be used.
     */
    customOutputExtractor?: (
      output: RunResult<TContext, Agent<TContext, any>>,
    ) => string | Promise<string>;
  }): FunctionTool {
    const { toolName, toolDescription, customOutputExtractor } = options;
    return tool({
      name: toolName ?? toFunctionToolName(this.name),
      description: toolDescription ?? '',
      parameters: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
      strict: true,
      execute: async (data, context) => {
        if (!isAgentToolInput(data)) {
          throw new ModelBehaviorError('Agent tool called with invalid input');
        }

        const runner = new Runner();
        const result = await runner.run(this, data.input, {
          context: context?.context,
        });
        if (typeof customOutputExtractor === 'function') {
          return customOutputExtractor(result as any);
        }
        return getOutputText(
          result.rawResponses[result.rawResponses.length - 1],
        );
      },
    });
  }

  /**
   * Returns the system prompt for the agent.
   *
   * If the agent has a function as its instructions, this function will be called with the
   * runContext and the agent instance.
   */
  async getSystemPrompt(
    runContext: RunContext<TContext>,
  ): Promise<string | undefined> {
    if (typeof this.instructions === 'function') {
      return await this.instructions(runContext, this);
    }

    return this.instructions;
  }

  /**
   * Returns the prompt template for the agent, if defined.
   *
   * If the agent has a function as its prompt, this function will be called with the
   * runContext and the agent instance.
   */
  async getPrompt(
    runContext: RunContext<TContext>,
  ): Promise<Prompt | undefined> {
    if (typeof this.prompt === 'function') {
      return await this.prompt(runContext, this);
    }
    return this.prompt;
  }

  /**
   * Fetches the available tools from the MCP servers.
   * @returns the MCP powered tools
   */
  async getMcpTools(
    runContext: RunContext<TContext>,
  ): Promise<Tool<TContext>[]> {
    if (this.mcpServers.length > 0) {
      return getAllMcpTools({
        mcpServers: this.mcpServers,
        runContext,
        agent: this,
        convertSchemasToStrict: false,
      });
    }

    return [];
  }

  /**
   * ALl agent tools, including the MCPl and function tools.
   *
   * @returns all configured tools
   */
  async getAllTools(
    runContext: RunContext<TContext>,
  ): Promise<Tool<TContext>[]> {
    return [...(await this.getMcpTools(runContext)), ...this.tools];
  }

  /**
   * Processes the final output of the agent.
   *
   * @param output - The output of the agent.
   * @returns The parsed out.
   */
  processFinalOutput(output: string): ResolvedAgentOutput<TOutput> {
    if (this.outputType === 'text') {
      return output as ResolvedAgentOutput<TOutput>;
    }

    if (typeof this.outputType === 'object') {
      const parsed = JSON.parse(output);

      if (isZodObject(this.outputType)) {
        return this.outputType.parse(parsed) as ResolvedAgentOutput<TOutput>;
      }

      return parsed as ResolvedAgentOutput<TOutput>;
    }

    throw new Error(`Unknown output type: ${this.outputType}`);
  }

  /**
   * Returns a JSON representation of the agent, which is serializable.
   *
   * @returns A JSON object containing the agent's name.
   */
  toJSON() {
    return {
      name: this.name,
    };
  }
}
