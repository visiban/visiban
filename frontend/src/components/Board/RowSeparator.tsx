import { useState } from "react";

interface Props {
  isAdmin: boolean;
  onInsert: () => void;
}

export default function RowSeparator({ isAdmin, onInsert }: Props) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="flex flex-col items-center select-none"
      style={{ height: 12 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={isAdmin ? onInsert : undefined}
    >
      {/* Top line */}
      <div className={`w-full h-px transition-colors ${hovered && isAdmin ? "bg-blue-400/60" : "bg-slate-700"}`} />

      {/* Centre zone — shows "+" on hover */}
      <div className={`flex-1 w-full flex items-center justify-center transition-colors ${hovered && isAdmin ? "bg-blue-500/10 cursor-pointer" : ""}`}>
        {isAdmin && hovered && (
          <span className="text-blue-400 text-[10px] font-bold leading-none">+</span>
        )}
      </div>

      {/* Bottom line */}
      <div className={`w-full h-px transition-colors ${hovered && isAdmin ? "bg-blue-400/60" : "bg-slate-700"}`} />
    </div>
  );
}
