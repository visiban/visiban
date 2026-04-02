import { useState, useRef } from "react";
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

type Phase = "creating" | "post-creation";

export default function CreateGroupModal({ parentGroup, onCreated, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("creating");
  const [createdGroup, setCreatedGroup] = useState<Group | null>(null);
  const [createdSubgroups, setCreatedSubgroups] = useState<Group[]>([]);

  // --- Creating phase state ---
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // --- Post-creation phase state ---
  const [subgroupName, setSubgroupName] = useState("");
  const [subgroupSaving, setSubgroupSaving] = useState(false);
  const [subgroupError, setSubgroupError] = useState<string | null>(null);
  const subgroupInputRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    if (!name.trim() || description.length > DESCRIPTION_MAX) return;
    setSaving(true);
    setError(null);
    try {
      const group = await createGroup({
        name: name.trim(),
        description: description.trimEnd() || undefined,
        parent: parentGroup?.id ?? null,
      });
      onCreated(group);
      // Transition to post-creation state so the user can add subgroups
      // (or sub-subgroups when parentGroup is set) in one flow.
      setCreatedGroup(group);
      setPhase("post-creation");
      setTimeout(() => subgroupInputRef.current?.focus(), 0);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string; name?: string[] } } })?.response?.data;
      setError(detail?.detail ?? detail?.name?.[0] ?? "Failed to create group.");
    } finally {
      setSaving(false);
    }
  };

  const handleAddSubgroup = async () => {
    if (!subgroupName.trim() || !createdGroup) return;
    setSubgroupSaving(true);
    setSubgroupError(null);
    try {
      const subgroup = await createGroup({
        name: subgroupName.trim(),
        parent: createdGroup.id,
      });
      onCreated(subgroup);
      setCreatedSubgroups((prev) => [...prev, subgroup]);
      setSubgroupName("");
      subgroupInputRef.current?.focus();
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string; name?: string[] } } })?.response?.data;
      setSubgroupError(detail?.detail ?? detail?.name?.[0] ?? "Failed to create subgroup.");
    } finally {
      setSubgroupSaving(false);
    }
  };

  const descriptionCountColor =
    description.length > DESCRIPTION_MAX
      ? "text-red-400"
      : description.length >= DESCRIPTION_WARN
        ? "text-amber-400"
        : "text-slate-500";

  // --- Post-creation phase ---
  if (phase === "post-creation" && createdGroup) {
    return (
      <ModalWrapper
        open={true}
        onClose={onClose}
        title={`\u2713 ${createdGroup.name} created`}
        maxWidth="max-w-sm"
      >
        <div className="flex flex-col gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">
              Add Subgroups
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={subgroupInputRef}
                value={subgroupName}
                onChange={(e) => { setSubgroupName(e.target.value); setSubgroupError(null); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); handleAddSubgroup(); }
                }}
                placeholder="Subgroup name"
                disabled={subgroupSaving}
                className="flex-1 bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500 transition disabled:opacity-40"
              />
              <button
                onClick={handleAddSubgroup}
                disabled={!subgroupName.trim() || subgroupSaving}
                className="text-sm font-medium bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-blue-500 whitespace-nowrap"
              >
                {subgroupSaving ? "Adding…" : "+ Add"}
              </button>
            </div>
          </div>
          <p className="text-xs h-4">
            {subgroupError && <span className="text-red-400">{subgroupError}</span>}
          </p>
          {createdSubgroups.length > 0 && (
            <div className="max-h-40 overflow-y-auto">
              {createdSubgroups.map((sg, i) => (
                <div
                  key={sg.id}
                  className={`flex items-center gap-2 py-2 px-3 text-sm text-slate-300${i < createdSubgroups.length - 1 ? " border-b border-slate-700" : ""}`}
                >
                  <span className="text-green-400 text-xs">{"\u2713"}</span>
                  {sg.name}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 mt-5">
          <button
            onClick={onClose}
            className="text-sm font-medium bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Done
          </button>
        </div>
      </ModalWrapper>
    );
  }

  // --- Creating phase ---
  const title = parentGroup ? `New subgroup of "${parentGroup.name}"` : "New Group";

  return (
    <ModalWrapper open={true} onClose={onClose} title={title} maxWidth="max-w-sm">
      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Name *</label>
          <input
            ref={inputRef}
            autoFocus
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleCreate(); }
            }}
            placeholder={parentGroup ? "e.g. Backend" : "e.g. Engineering"}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500 transition"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide">Description <span className="text-slate-600">(optional)</span></label>
            <span className={`text-xs ${descriptionCountColor}`}>{description.length}/{DESCRIPTION_MAX}</span>
          </div>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this group for?"
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500 resize-none transition"
          />
        </div>
        <p className="text-xs h-4">
          {error && <span className="text-red-400">{error}</span>}
        </p>
      </div>
      <div className="flex items-center justify-end gap-3 mt-5">
        <button onClick={onClose} className="text-sm text-slate-300 hover:text-white hover:bg-slate-700 px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-blue-500">Cancel</button>
        <button
          onClick={handleCreate}
          disabled={!name.trim() || saving || description.length > DESCRIPTION_MAX}
          className="text-sm font-medium bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {saving ? "Creating…" : parentGroup ? "Create Subgroup" : "Create Group"}
        </button>
      </div>
    </ModalWrapper>
  );
}
