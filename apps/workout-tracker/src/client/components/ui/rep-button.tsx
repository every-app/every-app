interface RepButtonProps {
  reps: number;
  targetReps: number;
  isTouched: boolean;
  onClick: () => void;
}

export function RepButton({
  reps,
  targetReps,
  isTouched,
  onClick,
}: RepButtonProps) {
  const percentage = targetReps > 0 ? reps / targetReps : 0;

  let bgColor = "bg-base-300 text-base-content/50"; // Untouched

  if (isTouched) {
    if (reps === targetReps) {
      bgColor = "bg-success text-success-content"; // Hit target
    } else if (percentage >= 0.66) {
      bgColor = "bg-success text-success-content"; // > 66%
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
      {reps}
    </button>
  );
}
