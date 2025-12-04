interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:
    | "default"
    | "primary"
    | "secondary"
    | "accent"
    | "ghost"
    | "link"
    | "outline"
    | "error";
  size?: "default" | "sm" | "lg" | "xs" | "wide" | "block";
}

const variantClasses = {
  default: "btn",
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  accent: "btn btn-accent",
  ghost: "btn btn-ghost",
  link: "btn btn-link",
  outline: "btn btn-outline",
  error: "btn btn-error",
};

const sizeClasses = {
  default: "",
  xs: "btn-xs",
  sm: "btn-sm",
  lg: "btn-lg",
  wide: "btn-wide",
  block: "btn-block",
};

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonProps) {
  const classes = [variantClasses[variant], sizeClasses[size], className]
    .filter(Boolean)
    .join(" ");

  return <button className={classes} {...props} />;
}
