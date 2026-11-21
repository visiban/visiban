/** Which sign-in providers an instance turned on, in display order (#2479). */
export interface AuthProviders {
  google: boolean;
  github: boolean;
  gitlab: boolean;
  oidc: boolean;
  oidc_name: string | null;
}

/** OIDC first (#2479): an instance that turned on its own IdP wants it to lead. */
const ORDER = ["oidc", "google", "github", "gitlab"] as const;
export type ProviderId = (typeof ORDER)[number];

export function enabledProviders(providers: AuthProviders | null): ProviderId[] {
  return providers ? ORDER.filter((id) => providers[id]) : [];
}

