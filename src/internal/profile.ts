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

const M_UPDATE_PROFILE = `
  mutation SetUserInfo2(
    $Token: String!, $FirstName: String, $LastName: String,
    $CountryCode: String, $LanguageCode: String
  ) {
    setUserInfo2(
      Token: $Token, FirstName: $FirstName, LastName: $LastName,
      CountryCode: $CountryCode, LanguageCode: $LanguageCode
    )
  }
`;

// ---------------------------------------------------------------------------
// Interface (ISP / DIP)
// ---------------------------------------------------------------------------

export type ProfileUpdates = Partial<
  Pick<UserProfile, 'FirstName' | 'LastName' | 'CountryCode' | 'LanguageCode'>
>;

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
   */
  async updateProfile(updates: ProfileUpdates): Promise<void> {
    await this.gql<{ setUserInfo2: boolean }>(
      'SetUserInfo2',
      {
        FirstName: updates.FirstName ?? null,
        LastName: updates.LastName ?? null,
        CountryCode: updates.CountryCode ?? null,
        LanguageCode: updates.LanguageCode ?? null,
      },
      M_UPDATE_PROFILE,
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
