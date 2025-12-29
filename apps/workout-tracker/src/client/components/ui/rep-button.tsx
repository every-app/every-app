interface RepButtonProps {
  /** Actual reps if touched, null if untouched */
  reps: number | null;
  targetReps: number;
  onClick: () => void;
}

export function RepButton({ reps, targetReps, onClick }: RepButtonProps) {
  const displayReps = reps ?? targetReps;
  const isTouched = reps !== null;
  const percentage = targetReps > 0 ? displayReps / targetReps : 0;

  let bgColor = "bg-base-300 text-base-content/50"; // Untouched

  if (isTouched) {
    if (percentage >= 0.66) {
      bgColor = "bg-success text-success-content"; // >= 66%
    } else {
      bgColor = "bg-warning text-warning-content"; // < 66%
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full aspect-square text-lg sm:text-xl md:text-2xl rounded flex items-center justify-center font-semibold transition-all ${bgColor}`}
    >
      {displayReps}
    </button>
  );
}
