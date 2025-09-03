import { describe, it, expect, beforeAll } from 'vitest';
import {
  Agent,
  run,
  Runner,
  setDefaultModelProvider,
  setTracingDisabled,
  Usage,
  RunStreamEvent,
  RunAgentUpdatedStreamEvent,
  handoff,
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
  FunctionCallItem,
} from '../src';
import { FakeModel, FakeModelProvider, fakeModelMessage } from './stubs';

// Test for unhandled rejection when stream loop throws

describe('Runner.run (streaming)', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  it('does not emit unhandled rejection when stream loop fails', async () => {
    const agent = new Agent({ name: 'StreamFail', model: new FakeModel() });

    const rejections: unknown[] = [];
    const handler = (err: unknown) => {
      rejections.push(err);
    };
    process.on('unhandledRejection', handler);

    const result = await run(agent, 'hi', { stream: true });
    await expect(result.completed).rejects.toBeInstanceOf(Error);

    // allow queued events to fire
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', handler);

    expect(rejections).toHaveLength(0);
    expect(result.error).toBeInstanceOf(Error);
  });

  it('exposes model error to the consumer', async () => {
    const agent = new Agent({ name: 'StreamError', model: new FakeModel() });

    const result = await run(agent, 'hi', { stream: true });
    await expect(result.completed).rejects.toThrow('Not implemented');

    expect((result.error as Error).message).toBe('Not implemented');
  });

  it('emits agent_updated_stream_event with new agent on handoff', async () => {
    class SimpleStreamingModel implements Model {
      constructor(private resp: ModelResponse) {}
      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return this.resp;
      }
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        yield {
          type: 'response_done',
          response: {
            id: 'r',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: this.resp.output,
          },
        } as any;
      }
    }

    const agentB = new Agent({
      name: 'B',
      model: new SimpleStreamingModel({
        output: [fakeModelMessage('done B')],
        usage: new Usage(),
      }),
    });

    const callItem: FunctionCallItem = {
      id: 'h1',
      type: 'function_call',
      name: handoff(agentB).toolName,
      callId: 'c1',
      status: 'completed',
      arguments: '{}',
    };

    const agentA = new Agent({
      name: 'A',
      model: new SimpleStreamingModel({
        output: [callItem],
        usage: new Usage(),
      }),
      handoffs: [handoff(agentB)],
    });

    const result = await run(agentA, 'hi', { stream: true });
    const events: RunStreamEvent[] = [];
    for await (const e of result.toStream()) {
      events.push(e);
    }
    await result.completed;

    const update = events.find(
      (e): e is RunAgentUpdatedStreamEvent =>
        e.type === 'agent_updated_stream_event',
    );
    expect(update?.agent).toBe(agentB);
  });

  it('emits agent_end lifecycle event for streaming agents', async () => {
    class SimpleStreamingModel implements Model {
      constructor(private resp: ModelResponse) {}
      async getResponse(_req: ModelRequest): Promise<ModelResponse> {
        return this.resp;
      }
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        yield {
          type: 'response_done',
          response: {
            id: 'r',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: this.resp.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'TestAgent',
      model: new SimpleStreamingModel({
        output: [fakeModelMessage('Final output')],
        usage: new Usage(),
      }),
    });

    // Track agent_end events on both the agent and runner
    const agentEndEvents: Array<{ context: any; output: string }> = [];
    const runnerEndEvents: Array<{ context: any; agent: any; output: string }> = [];

    agent.on('agent_end', (context, output) => {
      agentEndEvents.push({ context, output });
    });

    // Create a runner instance to listen for events
    const runner = new Runner();
    runner.on('agent_end', (context, agent, output) => {
      runnerEndEvents.push({ context, agent, output });
    });

    const result = await runner.run(agent, 'test input', { stream: true });

    // Consume the stream
    const events: RunStreamEvent[] = [];
    for await (const e of result.toStream()) {
      events.push(e);
    }
    await result.completed;

    // Verify agent_end was called on both agent and runner
    expect(agentEndEvents).toHaveLength(1);
    expect(agentEndEvents[0].output).toBe('Final output');
    
    expect(runnerEndEvents).toHaveLength(1);
    expect(runnerEndEvents[0].agent).toBe(agent);
    expect(runnerEndEvents[0].output).toBe('Final output');
  });
});
