import { useId } from "react";
import { groupEventTypes } from "../../../constants/webhooks";

interface Props {
  /** `status.subscribable_event_types`: the only source of options. */
  options: string[];
  all: boolean;
  selected: string[];
  onChange: (next: { all: boolean; selected: string[] }) => void;
  errorId?: string;
  invalid?: boolean;
}

/**
 * Radio cards (All events / Only these events) with grouped inline checkboxes
 * (1.3 UI spec Part 8). Inline, not a dropdown, so the form claims no Escape
 * slot.
 */
export default function WebhookEventTypePicker({ options, all, selected, onChange, errorId, invalid }: Props) {
  const uid = useId();
  const toggle = (type: string, checked: boolean) => {
    const set = new Set(selected);
    if (checked) set.add(type);
    else set.delete(type);
    // Keep the server's order so the request body is stable.
    onChange({ all, selected: options.filter((o) => set.has(o)) });
  };
  const card = (value: boolean, title: string, hint?: string) => (
    <label
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition ${
        all === value ? "border-primary-emphasis bg-primary-emphasis/10" : "border-line hover:bg-surface-hover"
      }`}
    >
      <input
        type="radio"
        name={`${uid}-events`}
        className="accent-primary mt-1"
        checked={all === value}
        onChange={() => onChange({ all: value, selected })}
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium text-fg">{title}</span>
        {hint && <span className="text-xs text-fg-tertiary">{hint}</span>}
      </span>
    </label>
  );
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={errorId} data-invalid={invalid ? "true" : undefined}>
      <legend className="text-xs text-fg-tertiary mb-1">Events</legend>
      {card(true, "All events", "Includes event types added in later versions.")}
      {card(false, "Only these events")}
      {!all && (
        <div role="group" aria-label="Event types" className="ml-6 border-l-2 border-line pl-4 flex flex-col gap-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            {groupEventTypes(options).map((group) => (
              <fieldset key={group.label}>
                <legend className="text-xs font-medium text-fg-tertiary mb-1">{group.label}</legend>
                {group.types.map((type) => (
                  <label key={type} className="flex items-center gap-2 min-h-6">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={selected.includes(type)}
                      onChange={(e) => toggle(type, e.target.checked)}
                    />
                    <span className="font-mono text-xs text-fg-secondary">{type}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <p className="text-xs text-fg-tertiary">{selected.length} selected</p>
        </div>
      )}
    </fieldset>
  );
}
