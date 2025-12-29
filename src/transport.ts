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

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const errorText = await response.text();
    try {
      const parsed = JSON.parse(errorText) as unknown;
      if (isRecord(parsed)) {
        if (typeof parsed['error'] === 'string') {
          return parsed['error'];
        }
        return `HTTP ${response.status}`;
      }
    } catch {
      // Not JSON, fall back to text
    }
    if (errorText.trim().length > 0) return errorText;
  } catch {
    /* ignore body errors */
  }
  return `HTTP ${response.status}`;
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
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          ...options.headers,
        },
        signal: buildSignal(timeout, options.signal as AbortSignal | undefined),
      });

      if (responseHook) {
        try {
          responseHook(response.clone());
        } catch {
          /* ignore hook errors */
        }
      }

      if (!response.ok) {
        // eslint-disable-next-line no-await-in-loop
        const errorMessage = await parseErrorMessage(response);
        const shouldRetry =
          retryable && response.status >= 500 && response.status < 600 && attempt < maxRetries;
        if (shouldRetry) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(DEFAULT_BACKOFF_MS * (attempt + 1));
          continue;
        }
        throw new TaskForceAIError(errorMessage, response.status);
      }

      // eslint-disable-next-line no-await-in-loop
      const data = (await response.json()) as unknown;
      return data as T;
    } catch (error) {
      if (error instanceof TaskForceAIError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TaskForceAIError('Request timeout');
      }
      if (retryable && attempt < maxRetries) {
        // eslint-disable-next-line no-await-in-loop
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
