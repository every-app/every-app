interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Card({ className, ...props }: CardProps) {
  return (
    <div
      className={`card bg-base-100${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: CardProps) {
  return <div className={className} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={`card-title${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={`text-sm opacity-70${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: CardProps) {
  return <div className={className} {...props} />;
}

export function CardFooter({ className, ...props }: CardProps) {
  return (
    <div
      className={`card-actions justify-end${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}
