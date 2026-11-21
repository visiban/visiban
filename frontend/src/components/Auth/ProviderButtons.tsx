import { PROVIDER_META, ProviderIcon, providerLabel } from "../Common/ProviderIcons";
import { enabledProviders, type AuthProviders, type ProviderId } from "./providers";

const CLASSES =
  "flex w-full items-center justify-center gap-3 h-9 max-sm:h-12 px-4 rounded text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/**
 * "Continue with <provider>" buttons for the providers this instance turned on, in the brand
 * styling of #1328 (PROVIDER_META). Rendered as links when `hrefFor` is given (a plain
 * navigation to the provider), else as buttons calling `onSelect` (JoinPage stores the invite
 * before redirecting).
 */
export default function ProviderButtons({ providers, hrefFor, onSelect }: {
  providers: AuthProviders | null;
  hrefFor?: (id: ProviderId) => string;
  onSelect?: (id: ProviderId) => void;
}) {
  const ids = enabledProviders(providers);
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {ids.map((id) => {
        const label = `Continue with ${providerLabel(id, providers?.oidc_name) || "SSO"}`;
        const className = `${CLASSES} ${PROVIDER_META[id].buttonClassName}`;
        const icon = id === "oidc" ? null : <ProviderIcon id={id} className="w-5 h-5" />;
        return hrefFor ? (
          <a key={id} href={hrefFor(id)} className={className}>{icon}{label}</a>
        ) : (
          <button key={id} type="button" onClick={() => onSelect?.(id)} className={className}>{icon}{label}</button>
        );
      })}
    </div>
  );
}
