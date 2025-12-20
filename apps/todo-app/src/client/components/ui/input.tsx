import { forwardRef } from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={`input input-bordered w-full focus:outline-none${className ? ` ${className}` : ""}`}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
