interface ProgressBarProps {
  value: number;
  max: number;
  variant?: "primary" | "success" | "warning" | "error" | "neutral";
  className?: string;
}

const variantClasses = {
  primary: "progress-primary",
  success: "progress-success",
  warning: "progress-warning",
  error: "progress-error",
  neutral: "",
};

export function ProgressBar({
  value,
  max,
  variant,
  className,
}: ProgressBarProps) {
  const classes = [
    "progress w-full h-2",
    variant ? variantClasses[variant] : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <progress className={classes} value={value} max={max} />;
}
