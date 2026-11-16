// #2357 — the Filter panel's editor for a number custom field: an operator
// dropdown above zero, one, or two number inputs. The stored shape and its
// carry-over rules live in utils/numberFilter.ts; this component only renders.
import { useState } from "react";
import type { CustomFieldDefinition } from "../../types";
import SingleSelectDropdown from "../Common/SingleSelectDropdown";
import {
  NUMBER_FILTER_MODE_OPTIONS,
  displayedNumberFilterMode,
  numberFilterMode,
  isNumberRangeInverted,
  numberInputStep,
  switchNumberFilterMode,
  type NumberFilterMode,
  type NumberFilterValue,
} from "../../utils/numberFilter";

// Above the Filter panel's own Escape (25) and its save-name input (27), so
// the first Escape closes this menu and a second one closes the panel.
const OPERATOR_ESCAPE_PRIORITY = 28;

interface Props {
  definition: Pick<CustomFieldDefinition, "id" | "name" | "number_decimals">;
  value: NumberFilterValue;
  onChange: (value: NumberFilterValue) => void;
  /** The panel's shared input styling. */
  inputClass: string;
}

export default function NumberFilterEditor({ definition: def, value, onChange, inputClass }: Props) {
  // Seeded with the mode the editor opened in, so clearing one bound of a
  // "between" while typing does not flip the inputs to "at least"/"at most".
  const [picked, setPicked] = useState<NumberFilterMode | null>(() => numberFilterMode(value));
  const mode = displayedNumberFilterMode(value, picked);
  const step = numberInputStep(def.number_decimals);
  const inverted = isNumberRangeInverted(value);
  const errorId = `${def.id}-range-error`;
  // Swap the border color rather than appending one: two border-color utilities
  // on one element resolve by stylesheet order, not class order.
  const boundClass = `${inverted ? inputClass.replace("border-line-strong", "border-danger") : inputClass} flex-1 min-w-0 max-sm:min-h-11`;
  const invalidProps = inverted ? { "aria-invalid": true as const, "aria-describedby": errorId } : {};
  const min = value.min ?? "";
  const max = value.max ?? "";
  // Every non-eq write carries equals: "" — see utils/numberFilter.ts.
  const setBounds = (nextMin: string, nextMax: string) =>
    onChange({ kind: "number", equals: "", op: "between", min: nextMin, max: nextMax });

  const minInput = (
    <input type="number" step={step} aria-label={`${def.name} minimum`} placeholder="Min" value={min} onChange={(e) => setBounds(e.target.value, max)} className={boundClass} {...invalidProps} />
  );
  const maxInput = (
    <input type="number" step={step} aria-label={`${def.name} maximum`} placeholder="Max" value={max} onChange={(e) => setBounds(min, e.target.value)} className={boundClass} {...invalidProps} />
  );

  return (
    <div className="space-y-2">
      <SingleSelectDropdown<NumberFilterMode>
        label="is"
        ariaLabel={`${def.name} operator`}
        className="w-full justify-between max-sm:min-h-11"
        escapePriority={OPERATOR_ESCAPE_PRIORITY}
        options={NUMBER_FILTER_MODE_OPTIONS}
        selected={mode}
        onChange={(m) => {
          if (!m || m === mode) return;
          setPicked(m);
          onChange(switchNumberFilterMode(value, m, mode));
        }}
      />
      {mode === "eq" && (
        <input
          type="number"
          step={step}
          aria-label={def.name}
          value={value.equals}
          onChange={(e) => onChange({ kind: "number", equals: e.target.value })}
          className={`${inputClass} max-sm:min-h-11`}
        />
      )}
      {mode === "between" && (
        <div className="flex gap-2">
          {minInput}
          <span className="text-xs text-fg-muted self-center">and</span>
          {maxInput}
        </div>
      )}
      {mode === "gte" && <div className="flex">{minInput}</div>}
      {mode === "lte" && <div className="flex">{maxInput}</div>}
      {mode === "empty" && <p className="text-xs text-fg-muted">Matches cards where this field is empty.</p>}
      {mode === "not_empty" && <p className="text-xs text-fg-muted">Matches cards where this field has any value.</p>}
      {inverted && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          Minimum is greater than maximum, so no cards will match.
        </p>
      )}
    </div>
  );
}
