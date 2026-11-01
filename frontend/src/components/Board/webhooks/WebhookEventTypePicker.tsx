import { groupEventTypes } from "../../../constants/webhooks";

interface Props {
  /** Options, from `status.subscribable_event_types` only. */
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Id of the helper/error slot, for aria-describedby. */
  describedBy?: string;
  invalid?: boolean;
}

/** Native checkboxes grouped by resource prefix, one fieldset per group (#863). */
export default function WebhookEventTypePicker({ options, selected, onChange, describedBy, invalid }: Props) {
  const toggle = (type: string, checked: boolean) => {
    const set = new Set(selected);
    if (checked) set.add(type);
    else set.delete(type);
    // Keep the server's order so the PATCH body is stable.
    onChange(options.filter((o) => set.has(o)));
  };
  return (
    <div className="flex flex-col gap-3" aria-describedby={describedBy}>
      {groupEventTypes(options).map((group) => (
        <fieldset key={group.prefix} aria-invalid={invalid ? true : undefined}>
          <legend className="text-xs font-medium text-fg-tertiary mb-1">{group.label}</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {group.types.map((type) => (
              <label key={type} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={selected.includes(type)}
                  onChange={(e) => toggle(type, e.target.checked)}
                />
                <span className="font-mono text-xs text-fg-secondary">{type}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
