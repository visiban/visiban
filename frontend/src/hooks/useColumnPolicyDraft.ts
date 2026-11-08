import { useRef, useState } from "react";
import type { Column, ColumnPolicy, ColumnPolicyMode } from "../types";
import type { CriterionDraft } from "../components/Board/ColumnPolicyEditor";
import { policyFromDraft } from "../utils/columnPolicy";

export interface ColumnPolicyDraft {
  entry: CriterionDraft[];
  done: CriterionDraft[];
  mode: ColumnPolicyMode;
  setEntry: (items: CriterionDraft[]) => void;
  setDone: (items: CriterionDraft[]) => void;
  setMode: (mode: ColumnPolicyMode) => void;
  nextKey: () => number;
  /** True when the drafts would save a different policy than the one seeded. */
  dirty: boolean;
  /** The policy to save: trimmed, blanks dropped, null when both lists are empty. */
  toPolicy: () => ColumnPolicy | null;
}

/**
 * Draft state for one column's policy editor (#1101, #2156). Seeded once from
 * the column at mount and never re-seeded from later props, so a live update
 * cannot overwrite what the user is typing. Shared by EditColumnModal and the
 * Board settings policies section so both surfaces diff and save the same way.
 *
 * WHY a seeded snapshot: callers send `policy` only when it changed, so saving
 * one surface never clobbers a policy another admin changed meanwhile.
 */
export function useColumnPolicyDraft(column: Pick<Column, "policy">): ColumnPolicyDraft {
  const keyRef = useRef(0);
  const nextKey = () => ++keyRef.current;
  const [entry, setEntry] = useState<CriterionDraft[]>(() => (column.policy?.entry ?? []).map((text) => ({ key: nextKey(), text })));
  const [done, setDone] = useState<CriterionDraft[]>(() => (column.policy?.done ?? []).map((text) => ({ key: nextKey(), text })));
  const [mode, setMode] = useState<ColumnPolicyMode>(column.policy?.mode ?? "advisory");
  const [seeded] = useState(() => JSON.stringify(policyFromDraft(column.policy?.entry ?? [], column.policy?.done ?? [], column.policy?.mode ?? "advisory")));
  const toPolicy = () => policyFromDraft(entry.map((c) => c.text), done.map((c) => c.text), mode);
  const dirty = JSON.stringify(toPolicy()) !== seeded;
  return { entry, done, mode, setEntry, setDone, setMode, nextKey, dirty, toPolicy };
}
