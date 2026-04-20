export default function Spinner({ size = "sm", label = "Loading" }: { size?: "sm" | "lg"; label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2">
      <div
        className={`border-2 border-primary border-t-transparent rounded-full animate-spin ${size === "lg" ? "w-8 h-8" : "w-5 h-5"}`}
        role="status"
        aria-label={label}
      />
    </div>
  );
}
