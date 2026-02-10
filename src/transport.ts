const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_MAX_RETRIES = 3;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const buildSignal = (timeoutMs: number, externalSignal?: AbortSignal): AbortSignal => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const withHttpContext = (response: Response, detail?: string): string => {
  const base = `HTTP ${response.status}`;
  if (!detail) {
    return base;
  }
  return `${base}: ${detail}`;
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  let errorText = '';
  try {
    errorText = await response.text();
  } catch {
    return withHttpContext(response);
  }

  const trimmed = errorText.trim();
  if (!trimmed) {
    return withHttpContext(response);
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        if (typeof parsed['error'] === 'string' && parsed['error'].trim()) {
          return withHttpContext(response, parsed['error']);
        }
        if (typeof parsed['message'] === 'string' && parsed['message'].trim()) {
          return withHttpContext(response, parsed['message']);
        }
      }
    } catch {
      return withHttpContext(response, trimmed);
    }
  }

  return withHttpContext(response, trimmed);
};

export class TaskForceAIError extends Error {
  constructor(
    message: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'TaskForceAIError';
  }
}

export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  responseHook?: (response: Response) => void;
}

export const makeRequest = async <T>(
  endpoint: string,
  options: RequestInit,
  { apiKey, baseUrl, timeout, responseHook }: TransportConfig,
  retryable = false,
  maxRetries = DEFAULT_MAX_RETRIES
): Promise<T> => {
  const url = `${baseUrl}${endpoint}`;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          ...(options.headers as Record<string, string>),
        },
        signal: buildSignal(timeout, options.signal as AbortSignal | undefined),
      });

      if (responseHook) {
        responseHook(response.clone());
      }

      if (!response.ok) {
        const errorMessage = await parseErrorMessage(response);
        const shouldRetry =
          retryable && response.status >= 500 && response.status < 600 && attempt < maxRetries;
        if (shouldRetry) {
          await sleep(DEFAULT_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw new TaskForceAIError(errorMessage, response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TaskForceAIError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TaskForceAIError('Request timeout');
      }
      if (retryable && attempt < maxRetries) {
        await sleep(DEFAULT_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw new TaskForceAIError(
        `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  throw new TaskForceAIError('Request failed after maximum retries');
};

export const transportDefaults = {
  timeout: DEFAULT_TIMEOUT_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  backoffMs: DEFAULT_BACKOFF_MS,
  pollIntervalMs: 2_000,
  maxPollAttempts: 150,
} as const;
