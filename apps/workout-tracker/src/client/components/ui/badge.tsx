interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?:
    | "default"
    | "primary"
    | "secondary"
    | "accent"
    | "info"
    | "success"
    | "warning"
    | "error"
    | "outline";
}

const variantClasses = {
  default: "badge",
  primary: "badge badge-primary",
  secondary: "badge badge-secondary",
  accent: "badge badge-accent",
  info: "badge badge-info",
  success: "badge badge-success",
  warning: "badge badge-warning",
  error: "badge badge-error",
  outline: "badge badge-outline",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  return (
    <div
      className={`${variantClasses[variant]}${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}
