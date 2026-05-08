import { AxiosInstance } from 'axios';
import { DegooError } from '../errors';
import { UserProfile } from '../types';
import { IAuthService } from './auth';
import { checkGqlErrors, throwDegooError } from './http';

// ---------------------------------------------------------------------------
// GraphQL query / mutation strings
// ---------------------------------------------------------------------------

const Q_GET_PROFILE = `
  query GetUserInfo3($Token: String!) {
    getUserInfo3(Token: $Token) {
      ID FirstName LastName Email AvatarURL CountryCode LanguageCode
      Phone AccountType UsedQuota TotalQuota OAuth2Provider GPMigrationStatus
    }
  }
`;

// ---------------------------------------------------------------------------
// Interface (ISP / DIP)
// ---------------------------------------------------------------------------

export type ProfileUpdates = Partial<
  Pick<UserProfile, 'FirstName' | 'LastName' | 'CountryCode' | 'LanguageCode'>
>;

const UPDATABLE_PROFILE_FIELDS = [
  'FirstName', 'LastName', 'CountryCode', 'LanguageCode',
] as const satisfies ReadonlyArray<keyof ProfileUpdates>;

/**
 * Contract for user-profile read/write operations.
 *
 * Lives separately from `IFileService` so callers (and tests) can depend
 * only on the surface they actually use.
 */
export interface IProfileService {
  getProfile(): Promise<UserProfile>;
  updateProfile(updates: ProfileUpdates): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Handles `getUserInfo3` / `setUserInfo2` against the Degoo GraphQL API.
 *
 * Depends on `IAuthService` for the current access token (DIP).
 */
export class ProfileService implements IProfileService {
  constructor(
    private readonly http: AxiosInstance,
    private readonly apiUrl: string,
    private readonly auth: IAuthService,
  ) {}

  async getProfile(): Promise<UserProfile> {
    const r = await this.gql<{ getUserInfo3: UserProfile | null }>(
      'GetUserInfo3', {}, Q_GET_PROFILE,
    );
    if (!r.getUserInfo3) throw new DegooError('Unauthorized');
    return r.getUserInfo3;
  }

  /**
   * Updates editable profile fields. Pass only the fields you want to change —
   * omitted fields are left untouched server-side.
   *
   * Brand-new accounts can have empty names; some Degoo flows expect the
   * profile to be populated.
   *
   * Implementation note: the mutation is built dynamically from the keys
   * actually being changed. A static mutation that declares all four
   * nullable variables would still send `null` to Degoo's resolver for the
   * omitted ones (AppSync substitutes `null` for missing nullable variables),
   * and Degoo treats `null` as an explicit clear — so `{ FirstName: 'X' }`
   * would silently blank `LastName`/`CountryCode`/`LanguageCode`.
   */
  async updateProfile(updates: ProfileUpdates): Promise<void> {
    const fields = UPDATABLE_PROFILE_FIELDS.filter(
      (k): k is typeof UPDATABLE_PROFILE_FIELDS[number] => updates[k] !== undefined,
    );
    if (fields.length === 0) return; // nothing to update — no-op

    const varDecls = fields.map((k) => `$${k}: String`).join(', ');
    const argList = fields.map((k) => `${k}: $${k}`).join(', ');
    const variables = Object.fromEntries(fields.map((k) => [k, updates[k]]));

    await this.gql<{ setUserInfo2: boolean }>(
      'SetUserInfo2',
      variables,
      `mutation SetUserInfo2($Token: String!, ${varDecls}) {
        setUserInfo2(Token: $Token, ${argList})
      }`,
    );
  }

  private async gql<T>(
    operationName: string,
    variables: Record<string, unknown>,
    query: string,
  ): Promise<T> {
    try {
      const { data } = await this.http.post<{ data: T; errors?: Array<{ message: string }> }>(
        this.apiUrl,
        { operationName, variables: { Token: this.auth.getToken(), ...variables }, query },
      );
      return checkGqlErrors(data);
    } catch (err) {
      throwDegooError(err);
    }
  }
}
