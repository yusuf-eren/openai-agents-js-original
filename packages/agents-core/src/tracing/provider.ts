import { getCurrentSpan, getCurrentTrace } from './context';
import { tracing } from '../config';
import logger from '../logger';
import { MultiTracingProcessor, TracingProcessor } from './processor';
import { NoopSpan, Span, SpanData, SpanOptions } from './spans';
import { NoopTrace, Trace, TraceOptions } from './traces';
import { generateTraceId } from './utils';

export type CreateSpanOptions<TData extends SpanData> = Omit<
  SpanOptions<TData>,
  'traceId'
> & { traceId?: string; disabled?: boolean };

export class TraceProvider {
  #multiProcessor: MultiTracingProcessor;
  #disabled: boolean;

  constructor() {
    this.#multiProcessor = new MultiTracingProcessor();
    this.#disabled = tracing.disabled;

    this.#addCleanupListeners();
  }

  /**
   * Add a processor to the list of processors. Each processor will receive all traces/spans.
   *
   * @param processor - The processor to add.
   */
  registerProcessor(processor: TracingProcessor): void {
    this.#multiProcessor.addTraceProcessor(processor);
  }

  /**
   * Set the list of processors. This will replace any existing processors.
   *
   * @param processors - The list of processors to set.
   */
  setProcessors(processors: TracingProcessor[]): void {
    this.#multiProcessor.setProcessors(processors);
  }

  /**
   * Get the current trace.
   *
   * @returns The current trace.
   */
  getCurrentTrace(): Trace | null {
    return getCurrentTrace();
  }

  getCurrentSpan(): Span<any> | null {
    return getCurrentSpan();
  }

  setDisabled(disabled: boolean): void {
    this.#disabled = disabled;
  }

  startExportLoop(): void {
    this.#multiProcessor.start();
  }

  createTrace(traceOptions: TraceOptions): Trace {
    if (this.#disabled) {
      logger.debug('Tracing is disabled, Not creating trace %o', traceOptions);
      return new NoopTrace();
    }

    const traceId = traceOptions.traceId ?? generateTraceId();
    const name = traceOptions.name ?? 'Agent workflow';

    logger.debug('Creating trace %s with name %s', traceId, name);

    return new Trace({ ...traceOptions, name, traceId }, this.#multiProcessor);
  }

  createSpan<TSpanData extends SpanData>(
    spanOptions: CreateSpanOptions<TSpanData>,
    parent?: Span<any> | Trace,
  ): Span<TSpanData> {
    if (this.#disabled || spanOptions.disabled) {
      logger.debug('Tracing is disabled, Not creating span %o', spanOptions);
      return new NoopSpan(spanOptions.data, this.#multiProcessor);
    }

    let parentId;
    let traceId;

    if (!parent) {
      const currentTrace = getCurrentTrace();
      const currentSpan = getCurrentSpan();

      if (!currentTrace) {
        logger.error(
          'No active trace. Make sure to start a trace with `withTrace()` first. Returning NoopSpan.',
        );
        return new NoopSpan(spanOptions.data, this.#multiProcessor);
      }

      if (
        currentSpan instanceof NoopSpan ||
        currentTrace instanceof NoopTrace
      ) {
        logger.debug(
          `Parent ${currentSpan} or ${currentTrace} is no-op, returning NoopSpan`,
        );
        return new NoopSpan(spanOptions.data, this.#multiProcessor);
      }

      traceId = currentTrace.traceId;
      if (currentSpan) {
        logger.debug('Using parent span %s', currentSpan.spanId);
        parentId = currentSpan.spanId;
      } else {
        logger.debug(
          'No parent span, using current trace %s',
          currentTrace.traceId,
        );
      }
    } else if (parent instanceof Trace) {
      if (parent instanceof NoopTrace) {
        logger.debug('Parent trace is no-op, returning NoopSpan');
        return new NoopSpan(spanOptions.data, this.#multiProcessor);
      }

      traceId = parent.traceId;
    } else if (parent instanceof Span) {
      if (parent instanceof NoopSpan) {
        logger.debug('Parent span is no-op, returning NoopSpan');
        return new NoopSpan(spanOptions.data, this.#multiProcessor);
      }

      parentId = parent.spanId;
      traceId = parent.traceId;
    }

    if (!traceId) {
      logger.error(
        'No traceId found. Make sure to start a trace with `withTrace()` first. Returning NoopSpan.',
      );
      return new NoopSpan(spanOptions.data, this.#multiProcessor);
    }

    logger.debug(
      `Creating span ${JSON.stringify(spanOptions.data)} with id ${spanOptions.spanId ?? traceId}`,
    );

    return new Span(
      {
        ...spanOptions,
        traceId,
        parentId,
      },
      this.#multiProcessor,
    );
  }

  async shutdown(timeout?: number): Promise<void> {
    try {
      logger.debug('Shutting down tracing provider');
      await this.#multiProcessor.shutdown(timeout);
    } catch (error) {
      logger.error('Error shutting down tracing provider %o', error);
    }
  }

  /** Adds listeners to `process` to ensure `shutdown` occurs before exit. */
  #addCleanupListeners(): void {
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      // handling Node.js process termination
      const cleanup = async () => {
        const timeout = setTimeout(() => {
          console.warn('Cleanup timeout, forcing exit');
          process.exit(1);
        }, 5000);

        try {
          await this.shutdown();
        } finally {
          clearTimeout(timeout);
        }
      };

      // Handle normal termination
      process.on('beforeExit', cleanup);

      // Handle CTRL+C (SIGINT)
      process.on('SIGINT', async () => {
        await cleanup();
        if (!hasOtherListenersForSignals('SIGINT')) {
          // Only when there are no other listeners, exit the process on this SDK side
          process.exit(130);
        }
      });

      // Handle termination (SIGTERM)
      process.on('SIGTERM', async () => {
        await cleanup();
        if (!hasOtherListenersForSignals('SIGTERM')) {
          // Only when there are no other listeners, exit the process on this SDK side
          process.exit(0);
        }
      });

      process.on('unhandledRejection', async (reason, promise) => {
        logger.error('Unhandled rejection', reason, promise);
        await cleanup();
        if (!hasOtherListenersForEvents('unhandledRejection')) {
          // Only when there are no other listeners, exit the process on this SDK side
          process.exit(1);
        }
      });
    }
  }

  async forceFlush(): Promise<void> {
    await this.#multiProcessor.forceFlush();
  }
}

function hasOtherListenersForSignals(event: 'SIGINT' | 'SIGTERM'): boolean {
  return process.listeners(event).length > 1;
}

function hasOtherListenersForEvents(event: 'unhandledRejection'): boolean {
  return process.listeners(event).length > 1;
}

let GLOBAL_TRACE_PROVIDER: TraceProvider | undefined = undefined;
export function getGlobalTraceProvider(): TraceProvider {
  if (!GLOBAL_TRACE_PROVIDER) {
    GLOBAL_TRACE_PROVIDER = new TraceProvider();
  }
  return GLOBAL_TRACE_PROVIDER;
}
