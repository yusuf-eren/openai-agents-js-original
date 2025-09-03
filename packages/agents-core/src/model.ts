import { Usage } from './usage';
import { StreamEvent } from './types/protocol';
import { HostedTool, ComputerTool, FunctionTool } from './tool';
import { Handoff } from './handoff';
import {
  AgentInputItem,
  AgentOutputItem,
  JsonSchemaDefinition,
  TextOutput,
  InputText,
  InputImage,
  InputFile,
} from './types';

export type ModelSettingsToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | (string & {});

/**
 * Settings to use when calling an LLM.
 *
 * This class holds optional model configuration parameters (e.g. temperature,
 * topP, penalties, truncation, etc.).
 *
 * Not all models/providers support all of these parameters, so please check the API documentation
 * for the specific model and provider you are using.
 */
export type ModelSettings = {
  /**
   * The temperature to use when calling the model.
   */
  temperature?: number;

  /**
   * The topP to use when calling the model.
   */
  topP?: number;

  /**
   * The frequency penalty to use when calling the model.
   */
  frequencyPenalty?: number;

  /**
   * The presence penalty to use when calling the model.
   */
  presencePenalty?: number;

  /**
   * The tool choice to use when calling the model.
   */
  toolChoice?: ModelSettingsToolChoice;

  /**
   * Whether to use parallel tool calls when calling the model.
   * Defaults to false if not provided.
   */
  parallelToolCalls?: boolean;

  /**
   * The truncation strategy to use when calling the model.
   */
  truncation?: 'auto' | 'disabled';

  /**
   * The maximum number of output tokens to generate.
   */
  maxTokens?: number;

  /**
   * Whether to store the generated model response for later retrieval.
   * Defaults to true if not provided.
   */
  store?: boolean;

  /**
   * Additional provider specific settings to be passed directly to the model
   * request.
   */
  providerData?: Record<string, any>;
};

export type ModelTracing = boolean | 'enabled_without_data';

export type SerializedFunctionTool = {
  /**
   * The type of the tool.
   */
  type: FunctionTool['type'];

  /**
   * The name of the tool.
   */
  name: FunctionTool['name'];

  /**
   * The description of the tool that helps the model to understand when to use the tool
   */
  description: FunctionTool['description'];

  /**
   * A JSON schema describing the parameters of the tool.
   */
  parameters: FunctionTool['parameters'];

  /**
   * Whether the tool is strict. If true, the model must try to strictly follow the schema
   * (might result in slower response times).
   */
  strict: FunctionTool['strict'];
};

export type SerializedComputerTool = {
  type: ComputerTool['type'];
  name: ComputerTool['name'];
  environment: ComputerTool['computer']['environment'];
  dimensions: ComputerTool['computer']['dimensions'];
};

export type SerializedHostedTool = {
  type: HostedTool['type'];
  name: HostedTool['name'];
  providerData?: HostedTool['providerData'];
};

export type SerializedTool =
  | SerializedFunctionTool
  | SerializedComputerTool
  | SerializedHostedTool;

export type SerializedHandoff = {
  /**
   * The name of the tool that represents the handoff.
   */
  toolName: Handoff['toolName'];

  /**
   * The tool description for the handoff
   */
  toolDescription: Handoff['toolDescription'];

  /**
   * The JSON schema for the handoff input. Can be empty if the handoff does not take an input
   */
  inputJsonSchema: Handoff['inputJsonSchema'];

  /**
   * Whether the input JSON schema is in strict mode. We strongly recommend setting this to true,
   * as it increases the likelihood of correct JSON input.
   */
  strictJsonSchema: Handoff['strictJsonSchema'];
};

/**
 * The output type passed to the model. Has any Zod types serialized to JSON Schema
 */
export type SerializedOutputType = JsonSchemaDefinition | TextOutput;

/**
 * A request to a large language model.
 */
export type ModelRequest = {
  /**
   * The system instructions to use for the model.
   */
  systemInstructions?: string;

  /**
   * The input to the model.
   */
  input: string | AgentInputItem[];

  /**
   * The ID of the previous response to use for the model.
   */
  previousResponseId?: string;

  /**
   * The ID of stored conversation to use for the model.
   *
   * see https://platform.openai.com/docs/guides/conversation-state?api-mode=responses#openai-apis-for-conversation-state
   * see https://platform.openai.com/docs/api-reference/conversations/create
   */
  conversationId?: string;

  /**
   * The model settings to use for the model.
   */
  modelSettings: ModelSettings;

  /**
   * The tools to use for the model.
   */
  tools: SerializedTool[];

  /**
   * The type of the output to use for the model.
   */
  outputType: SerializedOutputType;

  /**
   * The handoffs to use for the model.
   */
  handoffs: SerializedHandoff[];

  /**
   * Whether to enable tracing for the model.
   */
  tracing: ModelTracing;

  /**
   * An optional signal to abort the model request.
   */
  signal?: AbortSignal;

  /**
   * The prompt template to use for the model, if any.
   */
  prompt?: Prompt;
};

export type ModelResponse = {
  /**
   * The usage information for response.
   */
  usage: Usage;

  /**
   * A list of outputs (messages, tool calls, etc.) generated by the model.
   */
  output: AgentOutputItem[];

  /**
   * An ID for the response which can be used to refer to the response in subsequent calls to the
   * model. Not supported by all model providers.
   */
  responseId?: string;

  /**
   * Raw response data from the underlying model provider.
   */
  providerData?: Record<string, any>;
};

/**
 * The base interface for calling an LLM.
 */
export interface Model {
  /**
   * Get a response from the model.
   *
   * @param request - The request to get a response for.
   */
  getResponse(request: ModelRequest): Promise<ModelResponse>;

  /**
   * Get a streamed response from the model.
   *
   */
  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent>;
}

/**
 * The base interface for a model provider.
 *
 * The model provider is responsible for looking up `Model` instances by name.
 */
export interface ModelProvider {
  /**
   * Get a model by name
   *
   * @param modelName - The name of the model to get.
   */
  getModel(modelName?: string): Promise<Model> | Model;
}

/**
 * Reference to a prompt template and its variables.
 */
export type Prompt = {
  /**
   * The unique identifier of the prompt template to use.
   */
  promptId: string;
  /**
   * Optional version of the prompt template.
   */
  version?: string;
  /**
   * Optional variables to substitute into the prompt template.
   * Can be a string, or an object with string keys and values that are string,
   * InputText, InputImage, or InputFile.
   */
  variables?: {
    [key: string]: string | InputText | InputImage | InputFile;
  };
};
