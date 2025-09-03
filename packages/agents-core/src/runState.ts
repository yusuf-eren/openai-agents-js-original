import { z } from 'zod';
import { Agent } from './agent';
import {
  RunMessageOutputItem,
  RunItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunReasoningItem,
  RunHandoffCallItem,
  RunHandoffOutputItem,
} from './items';
import type { ModelResponse } from './model';
import { RunContext } from './runContext';
import { getTurnInput } from './run';
import {
  AgentToolUseTracker,
  nextStepSchema,
  NextStep,
  ProcessedResponse,
} from './runImplementation';
import type { AgentSpanData } from './tracing/spans';
import type { Span } from './tracing/spans';
import { SystemError, UserError } from './errors';
import { getGlobalTraceProvider } from './tracing/provider';
import { Usage } from './usage';
import { Trace } from './tracing/traces';
import { getCurrentTrace } from './tracing';
import logger from './logger';
import { handoff } from './handoff';
import * as protocol from './types/protocol';
import { AgentInputItem, UnknownContext } from './types';
import type { InputGuardrailResult, OutputGuardrailResult } from './guardrail';
import { safeExecute } from './utils/safeExecute';
import { HostedMCPTool } from './tool';

/**
 * The schema version of the serialized run state. This is used to ensure that the serialized
 * run state is compatible with the current version of the SDK.
 * If anything in this schema changes, the version will have to be incremented.
 */
export const CURRENT_SCHEMA_VERSION = '1.0' as const;
const $schemaVersion = z.literal(CURRENT_SCHEMA_VERSION);

const serializedAgentSchema = z.object({
  name: z.string(),
});

const serializedSpanBase = z.object({
  object: z.literal('trace.span'),
  id: z.string(),
  trace_id: z.string(),
  parent_id: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  error: z
    .object({
      message: z.string(),
      data: z.record(z.string(), z.any()).optional(),
    })
    .nullable(),
  span_data: z.record(z.string(), z.any()),
});

type SerializedSpanType = z.infer<typeof serializedSpanBase> & {
  previous_span?: SerializedSpanType;
};

const SerializedSpan: z.ZodType<SerializedSpanType> = serializedSpanBase.extend(
  {
    previous_span: z.lazy(() => SerializedSpan).optional(),
  },
);

const usageSchema = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
});

const modelResponseSchema = z.object({
  usage: usageSchema,
  output: z.array(protocol.OutputModelItem),
  responseId: z.string().optional(),
  providerData: z.record(z.string(), z.any()).optional(),
});

const itemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_output_item'),
    rawItem: protocol.AssistantMessageItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_call_item'),
    rawItem: protocol.ToolCallItem.or(protocol.HostedToolCallItem),
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_call_output_item'),
    rawItem: protocol.FunctionCallResultItem,
    agent: serializedAgentSchema,
    output: z.string(),
  }),
  z.object({
    type: z.literal('reasoning_item'),
    rawItem: protocol.ReasoningItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('handoff_call_item'),
    rawItem: protocol.FunctionCallItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('handoff_output_item'),
    rawItem: protocol.FunctionCallResultItem,
    sourceAgent: serializedAgentSchema,
    targetAgent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_approval_item'),
    rawItem: protocol.FunctionCallItem.or(protocol.HostedToolCallItem),
    agent: serializedAgentSchema,
  }),
]);

const serializedTraceSchema = z.object({
  object: z.literal('trace'),
  id: z.string(),
  workflow_name: z.string(),
  group_id: z.string().nullable(),
  metadata: z.record(z.string(), z.any()),
});

const serializedProcessedResponseSchema = z.object({
  newItems: z.array(itemSchema),
  toolsUsed: z.array(z.string()),
  handoffs: z.array(
    z.object({
      toolCall: z.any(),
      handoff: z.any(),
    }),
  ),
  functions: z.array(
    z.object({
      toolCall: z.any(),
      tool: z.any(),
    }),
  ),
  computerActions: z.array(
    z.object({
      toolCall: z.any(),
      computer: z.any(),
    }),
  ),
  mcpApprovalRequests: z
    .array(
      z.object({
        requestItem: z.object({
          // protocol.HostedToolCallItem
          rawItem: z.object({
            type: z.literal('hosted_tool_call'),
            name: z.string(),
            arguments: z.string().optional(),
            status: z.string().optional(),
            output: z.string().optional(),
            // this always exists but marked as optional for early version compatibility; when releasing 1.0, we can remove the nullable and optional
            providerData: z.record(z.string(), z.any()).nullable().optional(),
          }),
        }),
        // HostedMCPTool
        mcpTool: z.object({
          type: z.literal('hosted_tool'),
          name: z.literal('hosted_mcp'),
          providerData: z.record(z.string(), z.any()),
        }),
      }),
    )
    .optional(),
});

const guardrailFunctionOutputSchema = z.object({
  tripwireTriggered: z.boolean(),
  outputInfo: z.any(),
});

const inputGuardrailResultSchema = z.object({
  guardrail: z.object({
    type: z.literal('input'),
    name: z.string(),
  }),
  output: guardrailFunctionOutputSchema,
});

const outputGuardrailResultSchema = z.object({
  guardrail: z.object({
    type: z.literal('output'),
    name: z.string(),
  }),
  agentOutput: z.any(),
  agent: serializedAgentSchema,
  output: guardrailFunctionOutputSchema,
});

export const SerializedRunState = z.object({
  $schemaVersion,
  currentTurn: z.number(),
  currentAgent: serializedAgentSchema,
  originalInput: z.string().or(z.array(protocol.ModelItem)),
  modelResponses: z.array(modelResponseSchema),
  context: z.object({
    usage: usageSchema,
    approvals: z.record(
      z.string(),
      z.object({
        approved: z.array(z.string()).or(z.boolean()),
        rejected: z.array(z.string()).or(z.boolean()),
      }),
    ),
    context: z.record(z.string(), z.any()),
  }),
  toolUseTracker: z.record(z.string(), z.array(z.string())),
  maxTurns: z.number(),
  currentAgentSpan: SerializedSpan.nullable().optional(),
  noActiveAgentRun: z.boolean(),
  inputGuardrailResults: z.array(inputGuardrailResultSchema),
  outputGuardrailResults: z.array(outputGuardrailResultSchema),
  currentStep: nextStepSchema.optional(),
  lastModelResponse: modelResponseSchema.optional(),
  generatedItems: z.array(itemSchema),
  lastProcessedResponse: serializedProcessedResponseSchema.optional(),
  trace: serializedTraceSchema.nullable(),
});

/**
 * Serializable snapshot of an agent's run, including context, usage and trace.
 * While this class has publicly writable properties (prefixed with `_`), they are not meant to be
 * used directly. To read these properties, use the `RunResult` instead.
 *
 * Manipulation of the state directly can lead to unexpected behavior and should be avoided.
 * Instead, use the `approve` and `reject` methods to interact with the state.
 */
export class RunState<TContext, TAgent extends Agent<any, any>> {
  /**
   * Current turn number in the conversation.
   */
  public _currentTurn = 0;
  /**
   * The agent currently handling the conversation.
   */
  public _currentAgent: TAgent;
  /**
   * Original user input prior to any processing.
   */
  public _originalInput: string | AgentInputItem[];
  /**
   * Responses from the model so far.
   */
  public _modelResponses: ModelResponse[];
  /**
   * Active tracing span for the current agent if tracing is enabled.
   */
  public _currentAgentSpan: Span<AgentSpanData> | undefined;
  /**
   * Run context tracking approvals, usage, and other metadata.
   */
  public _context: RunContext<TContext>;
  /**
   * Tracks what tools each agent has used.
   */
  public _toolUseTracker: AgentToolUseTracker;
  /**
   * Items generated by the agent during the run.
   */
  public _generatedItems: RunItem[];
  /**
   * Maximum allowed turns before forcing termination.
   */
  public _maxTurns: number;
  /**
   * Whether the run has an active agent step in progress.
   */
  public _noActiveAgentRun = true;
  /**
   * Last model response for the previous turn.
   */
  public _lastTurnResponse: ModelResponse | undefined;
  /**
   * Results from input guardrails applied to the run.
   */
  public _inputGuardrailResults: InputGuardrailResult[];
  /**
   * Results from output guardrails applied to the run.
   */
  public _outputGuardrailResults: OutputGuardrailResult[];
  /**
   * Next step computed for the agent to take.
   */
  public _currentStep: NextStep | undefined = undefined;
  /**
   * Parsed model response after applying guardrails and tools.
   */
  public _lastProcessedResponse: ProcessedResponse<TContext> | undefined =
    undefined;
  /**
   * Trace associated with this run if tracing is enabled.
   */
  public _trace: Trace | null = null;

  constructor(
    context: RunContext<TContext>,
    originalInput: string | AgentInputItem[],
    startingAgent: TAgent,
    maxTurns: number,
  ) {
    this._context = context;
    this._originalInput = structuredClone(originalInput);
    this._modelResponses = [];
    this._currentAgentSpan = undefined;
    this._currentAgent = startingAgent;
    this._toolUseTracker = new AgentToolUseTracker();
    this._generatedItems = [];
    this._maxTurns = maxTurns;
    this._inputGuardrailResults = [];
    this._outputGuardrailResults = [];
    this._trace = getCurrentTrace();
  }

  /**
   * The history of the agent run. This includes the input items and the new items generated during the run.
   *
   * This can be used as inputs for the next agent run.
   */
  get history(): AgentInputItem[] {
    return getTurnInput(this._originalInput, this._generatedItems);
  }

  /**
   * Returns all interruptions if the current step is an interruption otherwise returns an empty array.
   */
  getInterruptions() {
    if (this._currentStep?.type !== 'next_step_interruption') {
      return [];
    }
    return this._currentStep.data.interruptions;
  }

  /**
   * Approves a tool call requested by the agent through an interruption and approval item request.
   *
   * To approve the request use this method and then run the agent again with the same state object
   * to continue the execution.
   *
   * By default it will only approve the current tool call. To allow the tool to be used multiple
   * times throughout the run, set the `alwaysApprove` option to `true`.
   *
   * @param approvalItem - The tool call approval item to approve.
   * @param options - Options for the approval.
   */
  approve(
    approvalItem: RunToolApprovalItem,
    options: { alwaysApprove?: boolean } = { alwaysApprove: false },
  ) {
    this._context.approveTool(approvalItem, options);
  }

  /**
   * Rejects a tool call requested by the agent through an interruption and approval item request.
   *
   * To reject the request use this method and then run the agent again with the same state object
   * to continue the execution.
   *
   * By default it will only reject the current tool call. To allow the tool to be used multiple
   * times throughout the run, set the `alwaysReject` option to `true`.
   *
   * @param approvalItem - The tool call approval item to reject.
   * @param options - Options for the rejection.
   */
  reject(
    approvalItem: RunToolApprovalItem,
    options: { alwaysReject?: boolean } = { alwaysReject: false },
  ) {
    this._context.rejectTool(approvalItem, options);
  }

  /**
   * Serializes the run state to a JSON object.
   *
   * This method is used to serialize the run state to a JSON object that can be used to
   * resume the run later.
   *
   * @returns The serialized run state.
   */
  toJSON(): z.infer<typeof SerializedRunState> {
    const output = {
      $schemaVersion: CURRENT_SCHEMA_VERSION,
      currentTurn: this._currentTurn,
      currentAgent: {
        name: this._currentAgent.name,
      },
      originalInput: this._originalInput as any,
      modelResponses: this._modelResponses.map((response) => {
        return {
          usage: {
            requests: response.usage.requests,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            totalTokens: response.usage.totalTokens,
          },
          output: response.output as any,
          responseId: response.responseId,
          providerData: response.providerData,
        };
      }),
      context: this._context.toJSON(),
      toolUseTracker: this._toolUseTracker.toJSON(),
      maxTurns: this._maxTurns,
      currentAgentSpan: this._currentAgentSpan?.toJSON() as any,
      noActiveAgentRun: this._noActiveAgentRun,
      inputGuardrailResults: this._inputGuardrailResults,
      outputGuardrailResults: this._outputGuardrailResults.map((r) => ({
        ...r,
        agent: r.agent.toJSON(),
      })),
      currentStep: this._currentStep as any,
      lastModelResponse: this._lastTurnResponse as any,
      generatedItems: this._generatedItems.map((item) => item.toJSON() as any),
      lastProcessedResponse: this._lastProcessedResponse as any,
      trace: this._trace ? (this._trace.toJSON() as any) : null,
    };

    // parsing the schema to ensure the output is valid for reparsing
    const parsed = SerializedRunState.safeParse(output);
    if (!parsed.success) {
      throw new SystemError(
        `Failed to serialize run state. ${parsed.error.message}`,
      );
    }

    return parsed.data;
  }

  /**
   * Serializes the run state to a string.
   *
   * This method is used to serialize the run state to a string that can be used to
   * resume the run later.
   *
   * @returns The serialized run state.
   */
  toString() {
    return JSON.stringify(this.toJSON());
  }

  /**
   * Deserializes a run state from a string.
   *
   * This method is used to deserialize a run state from a string that was serialized using the
   * `toString` method.
   */
  static async fromString<TContext, TAgent extends Agent<any, any>>(
    initialAgent: TAgent,
    str: string,
  ) {
    const [parsingError, jsonResult] = await safeExecute(() => JSON.parse(str));
    if (parsingError) {
      throw new UserError(
        `Failed to parse run state. ${parsingError instanceof Error ? parsingError.message : String(parsingError)}`,
      );
    }

    const currentSchemaVersion = jsonResult.$schemaVersion;
    if (!currentSchemaVersion) {
      throw new UserError('Run state is missing schema version');
    }
    if (currentSchemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw new UserError(
        `Run state schema version ${currentSchemaVersion} is not supported. Please use version ${CURRENT_SCHEMA_VERSION}`,
      );
    }

    const stateJson = SerializedRunState.parse(JSON.parse(str));

    const agentMap = buildAgentMap(initialAgent);

    //
    // Rebuild the context
    //
    const context = new RunContext<TContext>(
      stateJson.context.context as TContext,
    );
    context._rebuildApprovals(stateJson.context.approvals);

    //
    // Find the current agent from the initial agent
    //
    const currentAgent = agentMap.get(stateJson.currentAgent.name);
    if (!currentAgent) {
      throw new UserError(`Agent ${stateJson.currentAgent.name} not found`);
    }

    const state = new RunState<TContext, TAgent>(
      context,
      '',
      currentAgent as TAgent,
      stateJson.maxTurns,
    );
    state._currentTurn = stateJson.currentTurn;

    // rebuild tool use tracker
    state._toolUseTracker = new AgentToolUseTracker();
    for (const [agentName, toolNames] of Object.entries(
      stateJson.toolUseTracker,
    )) {
      state._toolUseTracker.addToolUse(
        agentMap.get(agentName) as TAgent,
        toolNames,
      );
    }

    // rebuild current agent span
    if (stateJson.currentAgentSpan) {
      if (!stateJson.trace) {
        logger.warn('Trace is not set, skipping tracing setup');
      }

      const trace = getGlobalTraceProvider().createTrace({
        traceId: stateJson.trace?.id,
        name: stateJson.trace?.workflow_name,
        groupId: stateJson.trace?.group_id ?? undefined,
        metadata: stateJson.trace?.metadata,
      });

      state._currentAgentSpan = deserializeSpan(
        trace,
        stateJson.currentAgentSpan,
      );
      state._trace = trace;
    }
    state._noActiveAgentRun = stateJson.noActiveAgentRun;

    state._inputGuardrailResults =
      stateJson.inputGuardrailResults as InputGuardrailResult[];
    state._outputGuardrailResults = stateJson.outputGuardrailResults.map(
      (r) => ({
        ...r,
        agent: agentMap.get(r.agent.name) as Agent<any, any>,
      }),
    ) as OutputGuardrailResult[];

    state._currentStep = stateJson.currentStep;

    state._originalInput = stateJson.originalInput;
    state._modelResponses = stateJson.modelResponses.map(
      deserializeModelResponse,
    );
    state._lastTurnResponse = stateJson.lastModelResponse
      ? deserializeModelResponse(stateJson.lastModelResponse)
      : undefined;

    state._generatedItems = stateJson.generatedItems.map((item) =>
      deserializeItem(item, agentMap),
    );
    state._lastProcessedResponse = stateJson.lastProcessedResponse
      ? await deserializeProcessedResponse(
          agentMap,
          state._currentAgent,
          state._context,
          stateJson.lastProcessedResponse,
        )
      : undefined;

    if (stateJson.currentStep?.type === 'next_step_handoff') {
      state._currentStep = {
        type: 'next_step_handoff',
        newAgent: agentMap.get(stateJson.currentStep.newAgent.name) as TAgent,
      };
    }
    return state;
  }
}

/**
 * @internal
 */
export function buildAgentMap(
  initialAgent: Agent<any, any>,
): Map<string, Agent<any, any>> {
  const map = new Map<string, Agent<any, any>>();
  const queue: Agent<any, any>[] = [initialAgent];

  while (queue.length > 0) {
    const currentAgent = queue.shift()!;
    if (map.has(currentAgent.name)) {
      continue;
    }
    map.set(currentAgent.name, currentAgent);

    for (const handoff of currentAgent.handoffs) {
      if (handoff instanceof Agent) {
        if (!map.has(handoff.name)) {
          queue.push(handoff);
        }
      } else if (handoff.agent) {
        if (!map.has(handoff.agent.name)) {
          queue.push(handoff.agent);
        }
      }
    }
  }

  return map;
}

/**
 * @internal
 */
export function deserializeSpan(
  trace: Trace,
  serializedSpan: SerializedSpanType,
): Span<any> {
  const spanData = serializedSpan.span_data;
  const previousSpan = serializedSpan.previous_span
    ? deserializeSpan(trace, serializedSpan.previous_span)
    : undefined;

  const span = getGlobalTraceProvider().createSpan(
    {
      spanId: serializedSpan.id,
      traceId: serializedSpan.trace_id,
      parentId: serializedSpan.parent_id ?? undefined,
      startedAt: serializedSpan.started_at ?? undefined,
      endedAt: serializedSpan.ended_at ?? undefined,
      data: spanData as any,
    },
    trace,
  );
  span.previousSpan = previousSpan;

  return span;
}

/**
 * @internal
 */
export function deserializeModelResponse(
  serializedModelResponse: z.infer<typeof modelResponseSchema>,
): ModelResponse {
  const usage = new Usage();
  usage.requests = serializedModelResponse.usage.requests;
  usage.inputTokens = serializedModelResponse.usage.inputTokens;
  usage.outputTokens = serializedModelResponse.usage.outputTokens;
  usage.totalTokens = serializedModelResponse.usage.totalTokens;

  return {
    usage,
    output: serializedModelResponse.output.map((item) =>
      protocol.OutputModelItem.parse(item),
    ),
    responseId: serializedModelResponse.responseId,
    providerData: serializedModelResponse.providerData,
  };
}

/**
 * @internal
 */
export function deserializeItem(
  serializedItem: z.infer<typeof itemSchema>,
  agentMap: Map<string, Agent<any, any>>,
): RunItem {
  switch (serializedItem.type) {
    case 'message_output_item':
      return new RunMessageOutputItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'tool_call_item':
      return new RunToolCallItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'tool_call_output_item':
      return new RunToolCallOutputItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
        serializedItem.output,
      );
    case 'reasoning_item':
      return new RunReasoningItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'handoff_call_item':
      return new RunHandoffCallItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'handoff_output_item':
      return new RunHandoffOutputItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.sourceAgent.name) as Agent<any, any>,
        agentMap.get(serializedItem.targetAgent.name) as Agent<any, any>,
      );
    case 'tool_approval_item':
      return new RunToolApprovalItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
  }
}

/**
 * @internal
 */
async function deserializeProcessedResponse<TContext = UnknownContext>(
  agentMap: Map<string, Agent<any, any>>,
  currentAgent: Agent<TContext, any>,
  context: RunContext<TContext>,
  serializedProcessedResponse: z.infer<
    typeof serializedProcessedResponseSchema
  >,
): Promise<ProcessedResponse<TContext>> {
  const allTools = await currentAgent.getAllTools(context);
  const tools = new Map(
    allTools
      .filter((tool) => tool.type === 'function')
      .map((tool) => [tool.name, tool]),
  );
  const computerTools = new Map(
    allTools
      .filter((tool) => tool.type === 'computer')
      .map((tool) => [tool.name, tool]),
  );
  const handoffs = new Map(
    currentAgent.handoffs.map((entry) => {
      if (entry instanceof Agent) {
        return [entry.name, handoff(entry)];
      }

      return [entry.toolName, entry];
    }),
  );

  const result = {
    newItems: serializedProcessedResponse.newItems.map((item) =>
      deserializeItem(item, agentMap),
    ),
    toolsUsed: serializedProcessedResponse.toolsUsed,
    handoffs: serializedProcessedResponse.handoffs.map((handoff) => {
      if (!handoffs.has(handoff.handoff.toolName)) {
        throw new UserError(`Handoff ${handoff.handoff.toolName} not found`);
      }

      return {
        toolCall: handoff.toolCall,
        handoff: handoffs.get(handoff.handoff.toolName)!,
      };
    }),
    functions: await Promise.all(
      serializedProcessedResponse.functions.map(async (functionCall) => {
        if (!tools.has(functionCall.tool.name)) {
          throw new UserError(`Tool ${functionCall.tool.name} not found`);
        }

        return {
          toolCall: functionCall.toolCall,
          tool: tools.get(functionCall.tool.name)!,
        };
      }),
    ),
    computerActions: serializedProcessedResponse.computerActions.map(
      (computerAction) => {
        const toolName = computerAction.computer.name;
        if (!computerTools.has(toolName)) {
          throw new UserError(`Computer tool ${toolName} not found`);
        }

        return {
          toolCall: computerAction.toolCall,
          computer: computerTools.get(toolName)!,
        };
      },
    ),
    mcpApprovalRequests: (
      serializedProcessedResponse.mcpApprovalRequests ?? []
    ).map((approvalRequest) => ({
      requestItem: new RunToolApprovalItem(
        approvalRequest.requestItem
          .rawItem as unknown as protocol.HostedToolCallItem,
        currentAgent,
      ),
      mcpTool: approvalRequest.mcpTool as unknown as HostedMCPTool,
    })),
  };

  return {
    ...result,
    hasToolsOrApprovalsToRun(): boolean {
      return (
        result.handoffs.length > 0 ||
        result.functions.length > 0 ||
        result.mcpApprovalRequests.length > 0 ||
        result.computerActions.length > 0
      );
    },
  };
}
