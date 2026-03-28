import { useState, useRef, useEffect } from "react";
import { createGroup } from "../../api/groups";
import type { Group } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

const DESCRIPTION_MAX = 500;
const DESCRIPTION_WARN = 450;

interface Props {
  parentGroup?: Group;
  onCreated: (group: Group) => void;
  onClose: () => void;
}

export default function CreateGroupModal({ parentGroup, onCreated, onClose }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // Store the timeout ID so we can clean it up on unmount to avoid memory leaks.
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  const handleSave = async () => {
    if (!name.trim() || description.length > DESCRIPTION_MAX) return;
    const createdName = name.trim();
    const createdDescription = description.trimEnd();
    setSaving(true);
    setError(null);
    try {
      const group = await createGroup({
        name: createdName,
        description: createdDescription || undefined,
        parent: parentGroup?.id ?? null,
      });
      onCreated(group);
      setName("");
      setDescription("");
      // Show success feedback for 2 seconds, then clear.
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
      }
      setSuccessMessage(`\u2713 "${createdName}" created`);
      successTimerRef.current = setTimeout(() => {
        setSuccessMessage(null);
        successTimerRef.current = null;
      }, 2000);
      // Return focus to the input so the user can immediately type the next group name.
      inputRef.current?.focus();
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string; name?: string[] } } })?.response?.data;
      setError(detail?.detail ?? detail?.name?.[0] ?? "Failed to create group.");
    } finally {
      setSaving(false);
    }
  };

  const descriptionCountColor =
    description.length > DESCRIPTION_MAX
      ? "text-red-400"
      : description.length >= DESCRIPTION_WARN
        ? "text-amber-400"
        : "text-slate-500";

  const title = parentGroup ? `New subgroup of "${parentGroup.name}"` : "New Group";

  return (
    <ModalWrapper open={true} onClose={onClose} title={title} maxWidth="max-w-sm">
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Name *</label>
          <input
            ref={inputRef}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); descriptionRef.current?.focus(); }
            }}
            placeholder="e.g. Engineering"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500 transition"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-slate-400">Description <span className="text-slate-600">(optional)</span></label>
            <span className={`text-xs ${descriptionCountColor}`}>{description.length}/{DESCRIPTION_MAX}</span>
          </div>
          <textarea
            ref={descriptionRef}
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this group for?"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500 resize-none transition"
          />
        </div>
        {/* Reserve fixed height so buttons don't shift when message appears/disappears. */}
        <p className="text-xs h-4">
          {error && <span className="text-red-400">{error}</span>}
          {successMessage && <span className="text-green-400">{successMessage}</span>}
        </p>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="text-sm text-slate-400 hover:text-white px-3 py-1.5 transition">{successMessage ? "Close" : "Cancel"}</button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving || description.length > DESCRIPTION_MAX}
          className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {saving ? "Creating…" : "Create"}
        </button>
      </div>
    </ModalWrapper>
  );
}
