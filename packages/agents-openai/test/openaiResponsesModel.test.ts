import { describe, it, expect, vi, beforeAll } from 'vitest';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';
import { HEADERS } from '../src/defaults';
import type OpenAI from 'openai';
import {
  setTracingDisabled,
  withTrace,
  type ResponseStreamEvent,
} from '@openai/agents-core';

describe('OpenAIResponsesModel', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });
  it('getResponse returns correct ModelResponse and calls client with right parameters', async () => {
    withTrace('test', async () => {
      const fakeResponse = {
        id: 'res1',
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7,
        },
        output: [
          {
            id: 'test_id',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hi' }],
            role: 'assistant',
          },
        ],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: 'inst',
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      const result = await model.getResponse(request as any);
      expect(createMock).toHaveBeenCalledTimes(1);
      const [args, opts] = createMock.mock.calls[0];
      expect(args.instructions).toBe('inst');
      expect(args.model).toBe('gpt-test');
      expect(args.input).toEqual([{ role: 'user', content: 'hello' }]);
      expect(opts).toEqual({ headers: HEADERS, signal: undefined });

      expect(result.usage.requests).toBe(1);
      expect(result.usage.inputTokens).toBe(3);
      expect(result.usage.outputTokens).toBe(4);
      expect(result.usage.totalTokens).toBe(7);
      expect(result.output).toEqual([
        {
          type: 'message',
          id: 'test_id',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hi' }],
          providerData: {},
        },
      ]);
      expect(result.responseId).toBe('res1');
    });
  });

  it('merges top-level reasoning and text settings into provider data for Responses API', async () => {
    withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-settings',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-settings');

      const request = {
        systemInstructions: undefined,
        input: 'hi',
        modelSettings: {
          reasoning: { effort: 'medium', summary: 'concise' },
          text: { verbosity: 'low' },
          providerData: {
            reasoning: { summary: 'override', note: 'provider' },
            text: { tone: 'playful' },
            customFlag: true,
          },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.reasoning).toEqual({
        effort: 'medium',
        summary: 'override',
        note: 'provider',
      });
      expect(args.text).toEqual({ verbosity: 'low', tone: 'playful' });
      expect(args.customFlag).toBe(true);

      // ensure original provider data object was not mutated
      expect(request.modelSettings.providerData.reasoning).toEqual({
        summary: 'override',
        note: 'provider',
      });
      expect(request.modelSettings.providerData.text).toEqual({
        tone: 'playful',
      });
    });
  });

  it('getStreamedResponse yields events and calls client with stream flag', async () => {
    withTrace('test', async () => {
      const fakeResponse = { id: 'res2', usage: {}, output: [] };
      const events: ResponseStreamEvent[] = [
        { type: 'response.created', response: fakeResponse as any },
        {
          type: 'response.output_text.delta',
          delta: 'delta',
        } as any,
      ];
      async function* fakeStream() {
        yield* events;
      }
      const createMock = vi.fn().mockResolvedValue(fakeStream());
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'model2');

      const abort = new AbortController();
      const request = {
        systemInstructions: undefined,
        input: 'data',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: abort.signal,
      };

      const received: ResponseStreamEvent[] = [];
      for await (const ev of model.getStreamedResponse(request as any)) {
        received.push(ev);
      }

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args, opts] = createMock.mock.calls[0];
      expect(args.model).toBe('model2');
      expect(opts).toEqual({ headers: HEADERS, signal: abort.signal });
      expect(received).toEqual([
        {
          type: 'response_started',
          providerData: events[0],
        },
        {
          type: 'model',
          event: events[0],
        },
        {
          type: 'output_text_delta',
          delta: 'delta',
          providerData: {
            type: 'response.output_text.delta',
          },
        },
        {
          type: 'model',
          event: events[1],
        },
      ]);
    });
  });
});
