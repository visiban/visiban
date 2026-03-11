import { useState } from "react";
import { generateInviteLink, deactivateInviteLink } from "../../api/groups";

interface Props {
  groupId: number;
}

export default function InviteLinkPanel({ groupId }: Props) {
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const data = await generateInviteLink(groupId);
      setLink(`${window.location.origin}/join/${data.token}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!link) return;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async () => {
    if (!confirm("Revoke this link? Anyone who has it will no longer be able to join.")) return;
    await deactivateInviteLink(groupId);
    setLink(null);
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-slate-300 mb-3">Invite link</h3>
      {link ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              readOnly
              value={link}
              className="flex-1 text-xs bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-300 outline-none"
            />
            <button
              onClick={handleCopy}
              className="text-xs bg-blue-600 text-white px-3 py-2 rounded-lg hover:bg-blue-700 transition whitespace-nowrap"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button
            onClick={handleRevoke}
            className="text-xs text-red-400 hover:text-red-300 self-start transition"
          >
            Revoke link
          </button>
        </div>
      ) : (
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {loading ? "Generating…" : "Generate invite link"}
        </button>
      )}
    </div>
  );
}
