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

export class TaskForceAI {
  private ak: string;
  private url: string;
  private t: number;
  private rh?: (r: Response) => void;
  constructor(o: TaskForceAIOptions) {
    this.ak = o.apiKey;
    this.url = o.baseUrl || 'https://taskforceai.chat/api/developer';
    this.t = o.timeout || def.timeout;
    this.rh = o.responseHook;
  }

  private req = <T>(e: string, i: RequestInit = {}, r = false) =>
    makeRequest<T>(
      e,
      i,
      { apiKey: this.ak, baseUrl: this.url, timeout: this.t, responseHook: this.rh },
      r,
      def.maxRetries
    );

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
      const s = await this.getTaskStatus(id);
      on?.(s);
      yield s;
      if (['completed', 'failed'].includes(s.status)) return;
      await Bun.sleep(ms);
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
