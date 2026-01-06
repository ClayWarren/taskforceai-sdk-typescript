import { TaskForceAIError, transportDefaults as def, makeRequest } from './transport';
import type {
  TaskForceAIOptions,
  TaskResult,
  TaskStatus,
  TaskStatusCallback,
  TaskStatusStream,
  TaskSubmissionOptions,
} from './types';
import { VERSION } from './types';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const MOCK_RESULT = 'This is a mock response. Configure your API key to get real results.';

export class TaskForceAI {
  private ak: string;
  private url: string;
  private t: number;
  private rh?: (r: Response) => void;
  private mm: boolean;
  private mcc: Map<string, number> = new Map();

  constructor(o: TaskForceAIOptions) {
    this.mm = o.mockMode ?? false;
    if (!this.mm && !o.apiKey) {
      throw new TaskForceAIError('API key is required when not in mock mode');
    }
    this.ak = o.apiKey || '';
    this.url = o.baseUrl || 'https://taskforceai.chat/api/developer';
    this.t = o.timeout || def.timeout;
    this.rh = o.responseHook;
  }

  private mockResponse<T>(e: string, method: string): T {
    if (method === 'POST' && e === '/run') {
      const taskId = `mock-${Math.random().toString(36).slice(2, 10)}`;
      this.mcc.set(taskId, 0);
      return { taskId, status: 'processing' } as T;
    }
    if (e.startsWith('/status/')) {
      const taskId = e.split('/').pop()!;
      const count = this.mcc.get(taskId) || 0;
      this.mcc.set(taskId, count + 1);
      if (count < 1) {
        return { taskId, status: 'processing', message: 'Mock task processing...' } as T;
      }
      return { taskId, status: 'completed', result: MOCK_RESULT } as T;
    }
    if (e.startsWith('/results/')) {
      const taskId = e.split('/').pop()!;
      return { taskId, status: 'completed', result: MOCK_RESULT } as T;
    }
    return { status: 'ok' } as T;
  }

  private req = <T>(e: string, i: RequestInit = {}, r = false): Promise<T> => {
    if (this.mm) {
      return Promise.resolve(this.mockResponse<T>(e, i.method || 'GET'));
    }
    return makeRequest<T>(
      e,
      i,
      { apiKey: this.ak, baseUrl: this.url, timeout: this.t, responseHook: this.rh },
      r,
      def.maxRetries
    );
  };

  async submitTask(p: string, o: TaskSubmissionOptions = {}): Promise<string> {
    if (typeof p !== 'string' || !p.trim())
      throw new TaskForceAIError('Prompt must be a non-empty string');
    const { vercelAiKey: v, silent: s = false, mock: m = false, ...rest } = o;
    const body: any = { prompt: p, options: { silent: s, mock: m, ...rest } };
    if (v) body.vercelAiKey = v;
    return (
      await this.req<{ taskId: string }>('/run', { method: 'POST', body: JSON.stringify(body) })
    ).taskId;
  }

  async getTaskStatus(id: any) {
    if (!id || typeof id !== 'string')
      throw new TaskForceAIError('Task ID must be a non-empty string');
    return this.req<TaskStatus>(`/status/${id}`, {}, true);
  }
  async getTaskResult(id: any) {
    if (!id || typeof id !== 'string')
      throw new TaskForceAIError('Task ID must be a non-empty string');
    return this.req<TaskResult>(`/results/${id}`);
  }

  private async *poll(
    id: string,
    ms: number,
    max: number,
    on?: TaskStatusCallback,
    sig?: AbortSignal
  ) {
    for (let i = 0; i < max; i++) {
      if (sig?.aborted) throw new TaskForceAIError('Task polling cancelled');
      // eslint-disable-next-line no-await-in-loop
      const s = await this.getTaskStatus(id);
      on?.(s);
      yield s;
      if (['completed', 'failed'].includes(s.status)) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(ms);
    }
    throw new TaskForceAIError('Task did not complete within the expected time');
  }

  async waitForCompletion(
    id: string,
    ms = def.pollIntervalMs,
    max = def.maxPollAttempts,
    on?: TaskStatusCallback,
    sig?: AbortSignal
  ): Promise<TaskResult> {
    for await (const s of this.poll(id, ms, max, on, sig)) {
      if (s.status === 'completed' && s.result) return s as TaskResult;
      if (s.status === 'failed') throw new TaskForceAIError(s.error || 'Task failed');
    }
    throw new TaskForceAIError('Task did not complete within the expected time');
  }

  async runTask(
    p: string,
    o: TaskSubmissionOptions = {},
    ms = def.pollIntervalMs,
    max = def.maxPollAttempts,
    on?: TaskStatusCallback
  ) {
    return this.waitForCompletion(await this.submitTask(p, o), ms, max, on);
  }

  streamTaskStatus(
    id: any,
    ms = def.pollIntervalMs,
    max = def.maxPollAttempts,
    on?: TaskStatusCallback,
    sig?: AbortSignal
  ): TaskStatusStream {
    if (!id || typeof id !== 'string')
      throw new TaskForceAIError('Task ID must be a non-empty string');
    let cancel = false;
    return {
      taskId: id,
      cancel: () => (cancel = true),
      [Symbol.asyncIterator]: async function* (this: TaskForceAI) {
        for await (const s of this.poll(id, ms, max, on, sig)) {
          if (cancel) throw new TaskForceAIError('Task stream cancelled');
          yield s;
        }
      }.bind(this),
    };
  }

  async runTaskStream(
    p: string,
    o: TaskSubmissionOptions = {},
    ms = def.pollIntervalMs,
    max = def.maxPollAttempts,
    on?: TaskStatusCallback,
    sig?: AbortSignal
  ) {
    return this.streamTaskStatus(await this.submitTask(p, o), ms, max, on, sig);
  }
}

export {
  TaskForceAIError,
  TaskStatus,
  TaskResult,
  TaskSubmissionOptions,
  TaskStatusCallback,
  TaskStatusStream,
  TaskForceAIOptions,
  VERSION,
  def as transportDefaults,
};
