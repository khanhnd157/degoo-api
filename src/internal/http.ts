import axios, { AxiosInstance } from 'axios';
import { DegooError } from '../errors';
import { DEFAULTS } from './constants';

// ---------------------------------------------------------------------------
// HTTP client factories
// ---------------------------------------------------------------------------

/**
 * Creates the primary Axios instance for all GraphQL API requests.
 *
 * Uses API-key authentication via the `x-api-key` header, which is required
 * by Degoo's AppSync endpoint on every request.
 */
export function createApiClient(userAgent: string, apiToken: string): AxiosInstance {
  return axios.create({
    headers: {
      'User-Agent': userAgent,
      'x-api-key': apiToken,
    },
    // Required for large file uploads; Axios defaults block streams over 10 MB.
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
}

/**
 * Creates the Axios instance for authentication endpoints.
 *
 * Degoo's login server validates several non-standard headers in addition to
 * the body. Missing them results in 400 or 403 errors.
 *
 * @param extraHeaders Optional overrides merged on top of the default login headers.
 */
export function createLoginClient(
  userAgent: string,
  apiToken: string,
  extraHeaders: Record<string, string> = {},
): AxiosInstance {
  return axios.create({
    headers: {
      'User-Agent': userAgent,
      'x-api-key': apiToken,
      ...DEFAULTS.loginHeaders,
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// GraphQL helpers
// ---------------------------------------------------------------------------

/**
 * Inspects a GraphQL response body for application-level errors.
 *
 * GraphQL servers always return HTTP 200, even for business errors —
 * the actual error payload lives in the `errors` array of the response body.
 * Callers must check this field explicitly; Axios will not throw for it.
 *
 * @throws DegooError with the first error message if `errors` is non-empty.
 * @returns The `data` field of the response, narrowed to `T`.
 */
export function checkGqlErrors<T>(response: {
  data: T;
  errors?: Array<{ message: string }>;
}): T {
  if (response.errors?.length) {
    throw new DegooError(response.errors[0].message);
  }
  return response.data;
}

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises any caught error into a `DegooError` and re-throws it.
 *
 * Conversion rules:
 * - **Axios HTTP error** → `DegooError` with `status` and the server's `Error`
 *   message if present, otherwise the Axios message.
 * - **DegooError** (already normalised) → re-thrown as-is.
 * - **Anything else** → re-thrown as-is (unexpected runtime failure).
 *
 * Always annotate catch blocks with `throwDegooError` as the final statement
 * so callers receive a consistent `DegooError` type regardless of root cause.
 *
 * @throws Always throws — return type is `never`.
 */
export function throwDegooError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const message =
      body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).Error === 'string'
        ? (body as Record<string, unknown>).Error as string
        : err.message;
    throw new DegooError(message, status);
  }
  throw err;
}
