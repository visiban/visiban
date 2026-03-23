interface Props {
  onCreateBoard: () => void;
  onJoinGroup: () => void;
}

export default function OnboardingEmptyState({ onCreateBoard, onJoinGroup }: Props) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <div className="mb-6 text-slate-600">
        <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="16" width="72" height="52" rx="6" stroke="currentColor" strokeWidth="3" />
          <rect x="4" y="16" width="72" height="16" rx="6" stroke="currentColor" strokeWidth="3" />
          <rect x="16" y="44" width="16" height="16" rx="3" fill="currentColor" opacity="0.3" />
          <rect x="40" y="44" width="16" height="16" rx="3" fill="currentColor" opacity="0.3" />
          <rect x="16" y="36" width="16" height="4" rx="2" fill="currentColor" opacity="0.2" />
          <rect x="40" y="36" width="16" height="4" rx="2" fill="currentColor" opacity="0.2" />
        </svg>
      </div>

      <h1 className="text-white text-xl font-semibold mb-2">Welcome to Visiban</h1>
      <p className="text-slate-400 text-sm max-w-sm mb-8 leading-relaxed">
        Your team's kanban workspace. Create a board to start tracking work, or join an existing group to collaborate.
      </p>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={onCreateBoard}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition"
        >
          Create my first board
        </button>
        <button
          onClick={onJoinGroup}
          className="px-6 py-2.5 border border-slate-600 hover:border-slate-400 text-slate-300 hover:text-white text-sm font-medium rounded-lg transition"
        >
          Join a group with an invite link
        </button>
      </div>
    </div>
  );
}
