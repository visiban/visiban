import { useEffect, useState } from "react";
import { dismissPendingConnect, getAuthProviders } from "../../api/auth";
import { providerLabel } from "../Common/ProviderIcons";
import { startProviderConnect } from "../../utils/oauth";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  /** The server's `pending_connect_provider` — the provider the user first tried. */
  provider: string;
  /** Called once "Not now" is chosen, so the parent can drop the pending field. */
  onDismissed: () => void;
}

/**
 * One-time "Connect {Provider}?" prompt after an OAuth email collision (#1314).
 *
 * Visibility is server-owned only: it is shown while the user's
 * `pending_connect_provider` is set, and "Not now" clears that field on the
 * server. No localStorage/sessionStorage flag — a client-side "seen" marker
 * would re-show the prompt on every other device and tab.
 */
export default function ConnectProviderModal({ provider, onDismissed }: Props) {
  const [open, setOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oidcName, setOidcName] = useState<string | null>(null);

  useEffect(() => {
    if (provider !== "oidc") return;
    getAuthProviders().then((p) => setOidcName(p.oidc_name)).catch(() => {});
  }, [provider]);

  const label = providerLabel(provider, oidcName);

  const handleConnect = () => {
    setSubmitting(true);
    setError(null);
    try {
      // A real navigation: the page unloads and the backend returns the
      // browser to /settings with the outcome. Any refusal is shown there.
      startProviderConnect(provider);
    } catch {
      setSubmitting(false);
      setError(`Couldn't start connecting ${label}. Please try again.`);
    }
  };

  const handleNotNow = () => {
    // Close immediately; the dismiss call runs in the background. If it
    // fails the prompt may reappear on a later load — an acceptable fallback,
    // never worth blocking the user over.
    setOpen(false);
    onDismissed();
    dismissPendingConnect().catch((err) => {
      console.warn("Failed to dismiss the connect prompt", err);
    });
  };

  return (
    <ModalWrapper
      open={open}
      onClose={() => { /* intentionally blocked — answer with Connect or Not now */ }}
      dismissable={false}
      title={`Connect ${label}?`}
      labelId="connect-provider-title"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-secondary">
          You're signed in. Want to connect {label} so you can use it to sign in next time?
        </p>
        <p className="text-xs text-fg-muted">You can disconnect it anytime in Settings → Security.</p>
        <p className="text-xs min-h-4">{error && <span className="text-danger" role="alert">{error}</span>}</p>
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleNotNow}
            className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-3 py-1.5 text-sm rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={handleConnect}
            disabled={submitting}
            className="px-3 py-1.5 text-sm font-medium bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
          >
            {submitting ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </ModalWrapper>
  );
}
