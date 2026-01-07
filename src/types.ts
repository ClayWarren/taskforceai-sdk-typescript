export const VERSION = '1.2.1';

export interface TaskForceAIOptions {
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  responseHook?: TaskResponseHook;
  mockMode?: boolean;
}

export type TaskSubmissionOptions = {
  [key: string]: unknown;
  modelId?: string;
  silent?: boolean;
  mock?: boolean;
  vercelAiKey?: string;
};

export interface TaskStatus {
  taskId: string;
  status: 'processing' | 'completed' | 'failed';
  result?: string;
  error?: string;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskResult extends TaskStatus {
  status: 'completed';
  result: string;
}

export type TaskStatusCallback = (status: TaskStatus) => void;
export type TaskResponseHook = (response: Response) => void;

export interface TaskStatusStream extends AsyncIterable<TaskStatus> {
  taskId: string;
  cancel(): void;
}
