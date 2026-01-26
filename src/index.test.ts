import { afterEach, describe, expect, it, vi } from 'bun:test';
import { z } from 'zod';

import { TaskForceAI, TaskForceAIError, TaskStatus } from './index';

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<Record<string, unknown>>;
  text?: () => Promise<string>;
  clone?: () => FetchResponse;
};

const globalWithFetch = globalThis as { fetch?: unknown };
const originalFetch = globalWithFetch.fetch;

const requestBodySchema = z.object({
  prompt: z.string(),
  options: z.object({
    mock: z.boolean(),
    silent: z.boolean(),
  }),
  vercelAiKey: z.string(),
});

function createMockResponse(data: Record<string, unknown>): FetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    clone: () => createMockResponse(data),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalFetch !== undefined) {
    globalWithFetch.fetch = originalFetch;
  } else {
    delete globalWithFetch.fetch;
  }
});

describe('TaskForceAI.makeRequest and helpers', () => {
  it('includes vercelAiKey at the top level of the payload', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({ taskId: 'task_123', status: 'processing', message: 'ok' })
      );
    globalWithFetch.fetch = fetchMock;

    const client = new TaskForceAI({
      apiKey: 'test-api-key',
      baseUrl: 'https://example.com/api/developer',
    });

    const taskId = await client.submitTask('Analyze data', {
      vercelAiKey: 'gateway-key',
      mock: true,
    });

    expect(taskId).toBe('task_123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://example.com/api/developer/run');
    const parsedBodyResult = requestBodySchema.safeParse(
      JSON.parse((options?.body as string) || '{}')
    );
    if (!parsedBodyResult.success) {
      throw new Error(`Invalid request body JSON: ${parsedBodyResult.error.message}`);
    }
    const parsedBody = parsedBodyResult.data;
    expect(parsedBody).toEqual({
      prompt: 'Analyze data',
      options: { mock: true, silent: false },
      vercelAiKey: 'gateway-key',
    });
  });

  it('defaults options when only vercelAiKey is provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({ taskId: 'task_456', status: 'processing', message: 'ok' })
      );
    globalWithFetch.fetch = fetchMock;

    const client = new TaskForceAI({
      apiKey: 'test-api-key',
    });

    await client.submitTask('Summarize report', {
      vercelAiKey: 'gateway-key',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = (fetchMock as unknown as { mock: { calls: [unknown, { body?: string }][] } }).mock.calls[0] ?? [];
    const parsedBodyResult = requestBodySchema.safeParse(
      JSON.parse(options?.body || '{}')
    );
    if (!parsedBodyResult.success) {
      throw new Error(`Invalid request body JSON: ${parsedBodyResult.error.message}`);
    }
    const parsedBody = parsedBodyResult.data;
    expect(parsedBody).toEqual({
      prompt: 'Summarize report',
      options: { mock: false, silent: false },
      vercelAiKey: 'gateway-key',
    });
  });

  it('throws a TaskForceAIError when prompt is invalid', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    await expect(client.submitTask('')).rejects.toThrow('Prompt must be a non-empty string');
  });

  it('extracts JSON error messages from failed responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: 'Not found' }),
      json: async () => ({}),
    });
    globalWithFetch.fetch = fetchMock;
    const client = new TaskForceAI({ apiKey: 'key', baseUrl: 'https://example.com/api/developer' });

    await expect(client.getTaskStatus('missing')).rejects.toThrowError(
      new TaskForceAIError('Not found', 404)
    );
  });

  it('falls back to status code when error payload lacks error field', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: 'oops' }),
      json: async () => ({}),
    });
    globalWithFetch.fetch = fetchMock;
    const client = new TaskForceAI({ apiKey: 'key', baseUrl: 'https://example.com/api/developer' });

    await expect(client.getTaskStatus('task')).rejects.toMatchObject({
      message: 'HTTP 500',
      statusCode: 500,
    });
  });

  it('wraps network errors into TaskForceAIError', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('unreachable'));
    globalWithFetch.fetch = fetchMock;
    const client = new TaskForceAI({ apiKey: 'key' });

    await expect(client.submitTask('prompt')).rejects.toThrow('Network error: unreachable');
  });

  it('treats non-Error rejections as unknown network errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue('fail');
    globalWithFetch.fetch = fetchMock;
    const client = new TaskForceAI({ apiKey: 'key' });

    await expect(client.submitTask('prompt')).rejects.toThrow('Network error: Unknown error');
  });

  it('converts AbortError into timeout error', async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn((_: unknown, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      let settled = false;

      return new Promise((_, reject) => {
        const abortHandler = () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abortHandler);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        };

        signal?.addEventListener('abort', abortHandler);
        setTimeout(() => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', abortHandler);
          reject(new Error('fetch did not abort in time'));
        }, 100);
      });
    });
    globalWithFetch.fetch = fetchMock;

    const client = new TaskForceAI({ apiKey: 'key', timeout: 20 });
    await expect(client.getTaskStatus('slow-task')).rejects.toThrow('Request timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invokes responseHook with the raw fetch response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        createMockResponse({ taskId: 'task_hook', status: 'completed', result: 'ok' })
      );
    const hook = vi.fn();
    globalWithFetch.fetch = fetchMock;

    const client = new TaskForceAI({ apiKey: 'key', responseHook: hook });
    await client.getTaskStatus('task_hook');

    expect(hook).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TaskForceAI task helpers', () => {
  it('validates task identifiers for status and result lookups', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    await expect(client.getTaskStatus('')).rejects.toThrow('Task ID must be a non-empty string');
    await expect(client.getTaskResult('')).rejects.toThrow('Task ID must be a non-empty string');
  });

  it('fetches task status and result through makeRequest', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ taskId: 'task', status: 'completed', result: 'done' }),
    });
    globalWithFetch.fetch = fetchMock;
    const client = new TaskForceAI({ apiKey: 'key', baseUrl: 'https://example.com/api/developer' });

    const status = await client.getTaskStatus('task');
    expect(status.status).toBe('completed');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ taskId: 'task', result: 'done' }),
    });
    const result = await client.getTaskResult('task');
    expect(result.result).toBe('done');
  });

  it('waits for completion successfully', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    const statuses: TaskStatus[] = [
      { taskId: 'task', status: 'processing' },
      { taskId: 'task', status: 'completed', result: 'done' },
    ];
    const statusSpy = vi
      .spyOn(client, 'getTaskStatus')
      .mockImplementation(async () => statuses.shift() as TaskStatus);

    const seen: TaskStatus[] = [];
    const finalResult = await client.waitForCompletion('task', 5 as 2000, 5 as 150, (status) => seen.push(status));

    expect(seen).toHaveLength(2);
    expect(finalResult).toEqual({ taskId: 'task', status: 'completed', result: 'done' });
    expect(statusSpy).toHaveBeenCalledTimes(2);
  });

  it('fails when task reports an error status', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    vi.spyOn(client, 'getTaskStatus').mockResolvedValue({
      taskId: 'task',
      status: 'failed',
      error: 'boom',
    });

    await expect(client.waitForCompletion('task')).rejects.toThrow('boom');
  });

  it('uses default failure message when status error is missing', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    vi.spyOn(client, 'getTaskStatus').mockResolvedValue({
      taskId: 'task',
      status: 'failed',
    });

    await expect(client.waitForCompletion('task')).rejects.toThrow('Task failed');
  });

  it('fails when task never completes within max attempts', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    vi.spyOn(client, 'getTaskStatus').mockResolvedValue({
      taskId: 'task',
      status: 'processing',
    });

    await expect(client.waitForCompletion('task', 5 as 2000, 2 as 150)).rejects.toThrow(
      'Task did not complete within the expected time'
    );
  });

  it('chains runTask through submitTask and waitForCompletion', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    const submitSpy = vi.spyOn(client, 'submitTask').mockResolvedValue('task-123');
    const waitSpy = vi.spyOn(client, 'waitForCompletion').mockResolvedValue({
      taskId: 'task-123',
      status: 'completed',
      result: 'ok',
    });

    const result = await client.runTask('prompt', { mock: true }, 10 as 2000, 2 as 150);

    expect(result).toEqual({ taskId: 'task-123', status: 'completed', result: 'ok' });
    expect(submitSpy).toHaveBeenCalledWith('prompt', { mock: true });
    expect(waitSpy).toHaveBeenCalledWith('task-123', 10, 2, undefined);
  });

  it('streams task status updates via AsyncIterable', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    const statuses: TaskStatus[] = [
      { taskId: 'task', status: 'processing' },
      { taskId: 'task', status: 'completed', result: 'ok' },
    ];
    vi.spyOn(client, 'getTaskStatus').mockImplementation(
      async () => statuses.shift() as TaskStatus
    );

    const received: TaskStatus[] = [];
    for await (const status of client.streamTaskStatus('task', 0 as 2000, 5 as 150)) {
      received.push(status);
    }

    expect(received).toHaveLength(2);
    expect(received[1]!.status).toBe('completed');
  });

  it('supports cancelling a task status stream', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    vi.spyOn(client, 'getTaskStatus')
      .mockResolvedValueOnce({ taskId: 'task', status: 'processing' })
      .mockResolvedValue({ taskId: 'task', status: 'processing' });

    const stream = client.streamTaskStatus('task', 0 as 2000, 5 as 150);
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value.status).toBe('processing');
    stream.cancel();
    await expect(iterator.next()).rejects.toThrow('Task stream cancelled');
  });

  it('returns a status stream from runTaskStream', async () => {
    const client = new TaskForceAI({ apiKey: 'key' });
    vi.spyOn(client, 'submitTask').mockResolvedValue('task-999');
    vi.spyOn(client, 'getTaskStatus').mockResolvedValue({
      taskId: 'task-999',
      status: 'completed',
      result: 'done',
    });

    const stream = await client.runTaskStream('prompt');
    const statuses: TaskStatus[] = [];
    for await (const status of stream) {
      statuses.push(status);
    }

    expect(stream.taskId).toBe('task-999');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.result).toBe('done');
  });
});
