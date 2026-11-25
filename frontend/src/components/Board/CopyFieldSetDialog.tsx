/**
 * "Copy a field set" (#2570): pick a board, then one of its sets, preview per
 * field, name, copy. A nested `max-w-md` modal over Board settings; Escape is
 * the section's 40.8 entry, which outranks both modals' 40.
 */
import { useEffect, useRef, useState } from "react";
import type { BoardFull, CustomFieldDefinition, CustomFieldSet } from "../../types";
import { copyFieldSet, listAllBoards, listCustomFieldDefinitions, listFieldSets } from "../../api/boards";
import { Button, buttonClasses } from "../Page";
import ModalWrapper from "../shared/ModalWrapper";
import { apiErrorMessage } from "../../utils/fieldSetSettings";
import { useOverflowFade } from "../../hooks/useOverflowFade";

const INPUT = "w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-primary-emphasis";
const BTN_PRIMARY = buttonClasses("primary", { className: "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-button-primary" });

export default function CopyFieldSetDialog({ board, onClose, onCopied }: { board: BoardFull; onClose: () => void; onCopied: (s: CustomFieldSet) => void | Promise<void> }) {
  const [boards, setBoards] = useState<{ id: number; name: string }[]>([]);
  const [sourceBoard, setSourceBoard] = useState<number | null>(null);
  const [sourceSets, setSourceSets] = useState<CustomFieldSet[]>([]);
  const [sourceDefs, setSourceDefs] = useState<CustomFieldDefinition[]>([]);
  const [sourceSet, setSourceSet] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const boardSelectRef = useRef<HTMLSelectElement>(null);
  const request = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => { boardSelectRef.current?.focus(); }, []);
  const chooseBoard = (id: number | null) => {
    // Clear at once and drop late answers, so board and set can never mismatch.
    const mine = ++request.current;
    setSourceBoard(id);
    setSourceSets([]);
    setSourceDefs([]);
    setSourceSet(null);
    setName("");
    setError(null);
    setLoading(id !== null);
    if (id === null) return;
    Promise.all([listFieldSets(id), listCustomFieldDefinitions(id)])
      .then(([s, d]) => { if (mine !== request.current) return; setSourceSets(s); setSourceDefs(d); setLoading(false); })
      .catch(() => { if (mine !== request.current) return; setError("Could not load that board's field sets."); setLoading(false); });
  };
  useEffect(() => { listAllBoards().then((bs) => setBoards(bs.filter((b) => b.id !== board.id).map((b) => ({ id: b.id, name: b.name })))).catch(() => setError("Could not load your boards.")); }, [board.id]);
  const chosen = sourceSets.find((s) => s.id === sourceSet) ?? null;
  const preview = chosen ? sourceDefs.filter((d) => chosen.field_ids.includes(d.id)).map((d) => {
    const local = board.custom_field_definitions.find((l) => l.name === d.name);
    const grouped = local && (board.custom_field_sets ?? []).some((s) => s.field_ids.includes(local.id));
    if (local && local.field_type === d.field_type && !grouped) return { d, text: "Uses existing field" };
    // The server picks the suffix ("(copied)", "(copied 2)", ...), so name none.
    if (local) return { d, text: `Creates a copy of ${d.name}` };
    return { d, text: "Creates new field" };
  }) : [];
  const adds = preview.filter((p) => p.text !== "Uses existing field").length;
  const room = 30 - board.custom_field_definitions.length;
  const { moreBelow, onScroll } = useOverflowFade(previewRef, [preview.length]);
  const copy = async () => {
    if (!chosen || sourceBoard === null || adds > room || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCopied(await copyFieldSet(board.id, { source_board: sourceBoard, source_set: chosen.id, name: name.trim() || undefined }));
    } catch (e) {
      setError(apiErrorMessage(e, "Could not copy the field set."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalWrapper open onClose={onClose} title="Copy a field set" maxWidth="max-w-md" labelId="field-set-copy-title">
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-fg-muted">Board
        <select ref={boardSelectRef} className={INPUT} value={sourceBoard ?? ""} onChange={(e) => chooseBoard(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Choose a board…</option>
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      {sourceBoard !== null && (
        <label className="flex flex-col gap-1 text-xs text-fg-muted">Field set
          <select className={INPUT} value={sourceSet ?? ""} onChange={(e) => {
            const id = e.target.value ? Number(e.target.value) : null;
            setError(null);
            setSourceSet(id);
            const s = sourceSets.find((x) => x.id === id);
            const taken = new Set((board.custom_field_sets ?? []).map((x) => x.name));
            setName(s ? (taken.has(s.name) ? `${s.name} (copy)` : s.name) : "");
          }}>
            <option value="">{loading ? "Loading…" : sourceSets.length ? "Choose a set…" : "That board has no field sets"}</option>
            {sourceSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      {chosen && (
        <>
          {/* Bounded: up to 30 rows must not push the footer off screen. */}
          <div className="relative">
            <div ref={previewRef} onScroll={onScroll} role="region" tabIndex={0} aria-label="Field preview"
              className="max-h-48 overflow-y-auto scroll-pb-8 rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis">
              <ul className="flex flex-col gap-0.5 text-sm" aria-label="Preview">
                {preview.map(({ d, text }) => <li key={d.id}>{d.name} <span className="text-xs text-fg-muted">— {text}</span></li>)}
              </ul>
            </div>
            {moreBelow && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface" />}
          </div>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">Name
            <input className={INPUT} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {adds > room && <p className="text-xs text-danger">Copying adds {adds} fields; this board has room for {Math.max(room, 0)}. Delete fields or choose a smaller set.</p>}
        </>
      )}
      <div role="status" className="text-xs text-danger">{error}</div>
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
        <button type="button" className={BTN_PRIMARY} aria-disabled={!chosen || adds > room || busy} aria-busy={busy || undefined} onClick={() => void copy()}>Copy field set</button>
      </div>
    </div>
    </ModalWrapper>
  );
}
