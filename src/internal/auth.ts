import { AxiosInstance } from 'axios';
import { DegooError } from '../errors';
import { SessionStore, AuthResult } from '../types';
import { throwDegooError } from './http';

// ---------------------------------------------------------------------------
// Interface (ISP / DIP)
// ---------------------------------------------------------------------------

/**
 * Contract for the authentication layer.
 *
 * Keeping auth separate from file/upload operations (ISP) lets each service
 * depend only on the token-access methods it actually needs (DIP).
 */
export interface IAuthService {
  /** Authenticate with email/password. Restores a cached session when possible. */
  login(email: string, password: string): Promise<AuthResult>;
  /** Clears auth state and removes the persisted session. */
  logout(): Promise<void>;
  /** Returns the current access token, or `''` if not authenticated. */
  getToken(): string;
  /** Returns the root folder ID, or `''` if not authenticated. */
  getRootPathId(): string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Handles all authentication flows:
 *
 * 1. **Fresh login** — POST /login → receive `Token` or `RefreshToken`.
 *    If only a `RefreshToken` is returned, exchange it via `/access-token/v2`
 *    to obtain a short-lived `AccessToken` for GraphQL calls.
 *
 * 2. **Session restore** — On each `login()` call the stored session is
 *    validated first.  If the access token has expired, a silent token
 *    refresh is attempted before falling back to a full re-login.
 *
 * 3. **Token refresh** — Exchange a `RefreshToken` for a new `AccessToken`
 *    without requiring the user's password again.
 */
export class AuthService implements IAuthService {
  private token = '';
  private refreshToken = '';
  private rootPathId = '';

  /**
   * @param loginHttp       Axios instance with Degoo login headers pre-configured.
   * @param apiHttp         Axios instance for GraphQL requests.
   * @param session         Persistent session storage strategy.
   * @param loginUrl        REST login endpoint.
   * @param accessTokenUrl  Token exchange endpoint.
   * @param apiUrl          GraphQL API endpoint.
   */
  constructor(
    private readonly loginHttp: AxiosInstance,
    private readonly apiHttp: AxiosInstance,
    private readonly session: SessionStore,
    private readonly loginUrl: string,
    private readonly accessTokenUrl: string,
    private readonly apiUrl: string,
  ) {}

  getToken(): string {
    return this.token;
  }

  getRootPathId(): string {
    return this.rootPathId;
  }

  /**
   * Logs in with email/password.
   *
   * If a valid cached session is found in the session store, the network
   * login is skipped entirely. This prevents unnecessary rate-limit exposure
   * when the process restarts frequently.
   */
  async login(email: string, password: string): Promise<AuthResult> {
    const restored = await this.restoreSession();
    if (restored) return { token: this.token, rootPathId: this.rootPathId };

    try {
      const { data } = await this.loginHttp.post<{
        Token?: string;
        RefreshToken?: string;
        Redirect: string;
      }>(this.loginUrl, {
        GenerateToken: true,
        Username: email,
        Password: password,
      });

      // The API may return a direct Token (older accounts) or a RefreshToken
      // that must be exchanged for an AccessToken (newer auth flow).
      const refreshToken = data.RefreshToken ?? data.Token ?? '';
      const accessToken = data.Token ? data.Token : await this.exchangeToken(refreshToken);

      this.token = accessToken;
      this.refreshToken = refreshToken;
      this.rootPathId = this.extractPathId(data.Redirect);

      // Persist the session for future restores.
      // Failure here is non-critical — the client is still logged in for this run.
      await this.session.save(this.serializeSession()).catch(() => undefined);
    } catch (err) {
      throwDegooError(err);
    }

    return { token: this.token, rootPathId: this.rootPathId };
  }

  async logout(): Promise<void> {
    this.token = '';
    this.refreshToken = '';
    this.rootPathId = '';
    await this.session.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Exchanges a long-lived `RefreshToken` for a short-lived `AccessToken`.
   *
   * @throws DegooError if the server returns an empty or missing `AccessToken`.
   */
  private async exchangeToken(refreshToken: string): Promise<string> {
    const { data } = await this.loginHttp.post<{ AccessToken?: string }>(
      this.accessTokenUrl,
      { RefreshToken: refreshToken },
    );
    if (!data.AccessToken) {
      throw new DegooError('Token exchange returned empty access token');
    }
    return data.AccessToken;
  }

  /**
   * Extracts the numeric folder ID embedded in a Degoo redirect path.
   *
   * Examples:
   * - `"/my-files/20877831487"` → `"20877831487"`
   * - `"/files/20877831487"`   → `"20877831487"`
   * - `"/moments"`             → `"0"` (root fallback)
   */
  private extractPathId(redirect: string): string {
    const match = redirect.match(/(\d+)\/?$/);
    return match ? match[1] : '0';
  }

  /**
   * Attempts to reuse a previously saved session.
   *
   * Strategy:
   * 1. Load credentials from the session store.
   * 2. Validate by calling the profile endpoint (lightweight token check).
   * 3. If expired: silently exchange the refresh token for a new access token.
   * 4. If refresh also fails: wipe state and return `false` to force re-login.
   */
  private async restoreSession(): Promise<boolean> {
    const stored = await this.session.load();
    if (!stored) return false;

    const parsed = this.parseSession(stored);
    if (!parsed?.token) return false;

    this.token = parsed.token;
    this.refreshToken = parsed.refreshToken;
    this.rootPathId = parsed.rootPathId;

    try {
      await this.validateToken();
      return true;
    } catch {
      // Access token may be expired — try a silent refresh before giving up.
      if (this.refreshToken) {
        try {
          this.token = await this.exchangeToken(this.refreshToken);
          await this.session.save(this.serializeSession()).catch(() => undefined);
          return true;
        } catch {
          // Refresh token also invalid — must do a full re-login.
        }
      }

      this.token = '';
      this.refreshToken = '';
      this.rootPathId = '';
      return false;
    }
  }

  /**
   * Serialises the in-memory session as JSON.
   *
   * The legacy newline-delimited format silently misparsed when any field
   * contained a newline (corrupted token, future schema additions). JSON
   * is robust against that and forward-compatible: new fields can land
   * here without breaking existing readers.
   */
  private serializeSession(): string {
    return JSON.stringify({
      v: 1,
      token: this.token,
      refreshToken: this.refreshToken,
      rootPathId: this.rootPathId,
    });
  }

  /**
   * Parses a stored session, accepting both the JSON format and the legacy
   * newline-delimited format (for users upgrading across SDK versions).
   * Returns `null` when the payload is unrecognisable.
   */
  private parseSession(
    raw: string,
  ): { token: string; refreshToken: string; rootPathId: string } | null {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed) as {
          token?: unknown; refreshToken?: unknown; rootPathId?: unknown;
        };
        if (typeof obj.token !== 'string') return null;
        return {
          token: obj.token,
          refreshToken: typeof obj.refreshToken === 'string' ? obj.refreshToken : '',
          rootPathId: typeof obj.rootPathId === 'string' ? obj.rootPathId : '',
        };
      } catch {
        return null;
      }
    }
    // Legacy newline-delimited format: token\nrefreshToken\nrootPathId
    const [token, refreshToken, rootPathId] = raw.split('\n');
    if (!token) return null;
    return {
      token,
      refreshToken: refreshToken ?? '',
      rootPathId: rootPathId ?? '',
    };
  }

  /**
   * Makes a minimal GraphQL call to check whether the current access token
   * is still accepted by the server.
   *
   * @throws DegooError('Unauthorized') if the token is invalid or expired.
   */
  private async validateToken(): Promise<void> {
    const query = `
      query GetUserInfo3($Token: String!) {
        getUserInfo3(Token: $Token) { ID Email }
      }
    `;

    const { data } = await this.apiHttp.post<{
      data: { getUserInfo3: { ID: string; Email: string } | null };
      errors?: Array<{ message: string }>;
    }>(this.apiUrl, {
      operationName: 'GetUserInfo3',
      variables: { Token: this.token },
      query,
    });

    if (data.errors?.length || !data.data?.getUserInfo3) {
      throw new DegooError('Unauthorized');
    }
  }
}
