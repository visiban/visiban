import { docsUrl } from "../../help/docsUrl";
import { HELP_TOPICS, type HelpTopic, type HelpTopicKey } from "../../help/topics";
import { ExternalIcon } from "../Layout/shellIcons";
import Tooltip from "./Tooltip";

interface Props {
  topic: HelpTopicKey;
  /** `icon` (default): "?" beside a section heading. `text`: visible words inside a callout or prose. */
  variant?: "icon" | "text";
  className?: string;
}

const RING = "focus:outline-none focus:ring-2 focus:ring-primary-emphasis";

/**
 * In-app help link (#2589). Surfaces name a registry topic, never a URL; the
 * accessible name comes from the registry so every link says where it goes.
 * One per section, never per control: it is a real tab stop.
 */
export default function HelpLink({ topic, variant = "icon", className = "" }: Props) {
  const entry: HelpTopic | undefined = HELP_TOPICS[topic];
  if (!entry) return null;
  const href = docsUrl(topic);

  if (variant === "text") {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1 min-h-6 max-sm:min-h-11 max-sm:-my-2.5 text-info underline rounded ${RING} ${className}`.trim()}
      >
        {entry.linkText ?? "Learn more"}
        <span className="sr-only">{` about ${entry.subject}, opens docs`}</span>
        <ExternalIcon className="w-3 h-3" aria-hidden="true" />
      </a>
    );
  }

  return (
    <Tooltip content={entry.summary} position="bottom">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Learn more about ${entry.subject}, opens docs`}
        className={`group relative inline-flex items-center justify-center shrink-0 w-5 h-5 max-sm:w-11 max-sm:h-11 max-sm:-my-3 max-sm:-mx-3 rounded-full ${RING} ${className}`.trim()}
      >
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-line-strong text-xs font-semibold leading-none text-fg-tertiary group-hover:text-info group-hover:border-primary-soft"
        >
          ?
        </span>
      </a>
    </Tooltip>
  );
}
