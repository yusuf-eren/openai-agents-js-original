import { describe, it, expect, vi } from 'vitest';
import type { RealtimeClientMessage } from '../src/clientMessages';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';

class TestBase extends OpenAIRealtimeBase {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'connected';
  events: RealtimeClientMessage[] = [];
  connect = vi.fn(async () => {});
  sendEvent(event: RealtimeClientMessage) {
    this.events.push(event);
  }
  mute = vi.fn();
  close = vi.fn();
  interrupt = vi.fn();
  get muted() {
    return false;
  }
}

function createToolCall() {
  return {
    type: 'function_call' as const,
    id: '1',
    callId: 'c1',
    name: 'tool',
    arguments: '{}',
  };
}

describe('OpenAIRealtimeBase helpers', () => {
  it('resolves api keys from options', async () => {
    const base = new TestBase({ apiKey: () => 'fromCtor' });
    const key1 = await (base as any)._getApiKey({});
    const key2 = await (base as any)._getApiKey({ apiKey: 'override' });

    expect(key1).toBe('fromCtor');
    expect(key2).toBe('override');
  });

  it('merges session config defaults', () => {
    const base = new TestBase();
    const config = (base as any)._getMergedSessionConfig({
      instructions: 'hi',
    });
    expect(config.instructions).toBe('hi');
    expect(Array.isArray(config.output_modalities)).toBe(true);
    expect(config.output_modalities.length).toBeGreaterThan(0);
    expect(config.audio?.input?.format).toBeDefined();
    expect(config.audio?.output?.format).toBeDefined();
    expect(config.audio?.output?.voice).toBeUndefined();
  });

  it('updateSessionConfig sends session.update', () => {
    const base = new TestBase();
    base.updateSessionConfig({ voice: 'echo' });
    expect(base.events[0]?.type).toBe('session.update');
    const session = (base.events[0] as any)?.session;
    expect(session?.audio?.output?.voice).toBe('echo');
  });

  it('sendFunctionCallOutput emits item_update and response.create', () => {
    const base = new TestBase();
    const updates: any[] = [];
    base.on('item_update', (e) => updates.push(e));
    base.sendFunctionCallOutput(createToolCall(), 'output', true);

    expect(base.events[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', output: 'output', call_id: 'c1' },
    });
    expect(base.events[1]).toEqual({ type: 'response.create' });
    expect(updates.length).toBe(1);
  });

  it('sendAudio optionally commits', () => {
    const base = new TestBase();
    const buf = new TextEncoder().encode('a').buffer;
    base.sendAudio(buf, { commit: true });
    expect(base.events[0]).toEqual({
      type: 'input_audio_buffer.append',
      audio: expect.any(String),
    });
    expect(base.events[1]).toEqual({ type: 'input_audio_buffer.commit' });
  });

  it('resetHistory sends delete and create events', () => {
    const base = new TestBase();
    const oldHist = [
      {
        itemId: '1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'a' }],
      },
    ];
    const newHist = [
      {
        itemId: '2',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'b' }],
      },
    ];
    base.resetHistory(oldHist as any, newHist as any);

    expect(base.events[0]).toEqual({
      type: 'conversation.item.delete',
      item_id: '1',
    });
    expect(base.events[1]).toEqual({
      type: 'conversation.item.create',
      item: {
        id: '2',
        role: 'user',
        type: 'message',
        status: 'completed',
        content: [{ type: 'input_text', text: 'b' }],
      },
    });
  });
});
