/**
 * Default values for all configurable SDK options.
 * Centralised here so they can be overridden in tests or forks without
 * touching business logic.
 *
 * SECURITY NOTE: `apiToken`, `userAgent`, and `loginHeaders` are app-level
 * credentials reverse-engineered from Degoo's web client — they are NOT user
 * credentials. They identify this SDK to Degoo's API, not an individual user.
 * All can be overridden via `DegooConfig` if Degoo rotates these values.
 * Never log or expose these values at runtime.
 */
export const DEFAULTS = {
  /** Degoo's AppSync GraphQL endpoint. */
  apiUrl: 'https://production-appsync.degoo.com/graphql',

  /** REST endpoint used for username/password login. */
  loginUrl: 'https://rest-api.degoo.com/login',

  /** REST endpoint that exchanges a RefreshToken for a short-lived AccessToken. */
  accessTokenUrl: 'https://rest-api.degoo.com/access-token/v2',

  /** AppSync API key, sent as `x-api-key` on every GraphQL request. */
  apiToken: 'da2-vs6twz5vnjdavpqndtbzg3prra',

  /**
   * User-Agent string accepted by Degoo's auth layer.
   * Standard browser UAs or Node's default UA cause login failures.
   */
  userAgent:
    'Mozilla/5.0 Slackware/13.37 (X11; U; Linux x86_64; en-US) AppleWebKit/534.16 (KHTML, like Gecko) Chrome/11.0.696.50',

  /**
   * Headers that Degoo's login endpoint validates in addition to the body.
   * Missing any of these results in 400 or 403 responses.
   */
  loginHeaders: {
    'x-amz-content': 'https://app.degoo.com',
    'x-api-authentication': 'iNDNjhDZzYWMxQTNtM2Y0IWLxIjY00COzcDNtYGN2Y2Y1gzM',
    'x-version': 'DegooWebClient/1.0:2022.11.11',
    Origin: 'degoo.com/CgQxMjE1',
    Referer: 'https://app.degoo.com/',
  },

  /** Default read-buffer size (bytes) for checksum streaming. */
  blockSize: 65536,
} as const;

/**
 * Tunable defaults for the download streaming layer.
 *
 * Centralised here so the streaming layer stays free of magic numbers and
 * tests / forks can adjust behaviour without editing implementation.
 */
export const DOWNLOAD_DEFAULTS = {
  /** Socket-inactivity timeout (ms). Connection is destroyed if no bytes flow. */
  timeoutMs: 60_000,
  /** Retries on transient connect/redirect errors before the body starts. */
  retries: 3,
  /** Maximum redirect depth followed before giving up. */
  maxRedirects: 10,
  /** Initial backoff between retries (ms). Doubled on each subsequent attempt. */
  initialBackoffMs: 500,
} as const;
