import * as React from "react"
import { cn } from "./utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  description?: string;
  error?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, label, description, error, id, ...props }, ref) => {
    const inputId = id || props.name || React.useId();
    const descriptionId = description ? `${inputId}-description` : undefined;
    const errorId = error ? `${inputId}-error` : undefined;
    
    return (
      <div className="space-y-1.5">
        {label && (
          <label 
            htmlFor={inputId}
            className="block text-[10px] font-black uppercase tracking-[0.2em] text-skitty-accent mb-2"
          >
            {label}
          </label>
        )}
        <input
          id={inputId}
          type={type}
          className={cn(
            "w-full rounded-none border-2 border-black bg-white/5 px-4 py-3 text-sm text-skitty-primary placeholder:text-skitty-secondary/30 focus:outline-none focus:ring-2 focus:ring-skitty-accent focus:bg-white/10 transition-all",
            error && "border-red-500 focus:ring-red-500",
            className
          )}
          ref={ref}
          aria-describedby={cn(descriptionId, errorId)}
          {...props}
        />
        {description && !error && (
          <p id={descriptionId} className="text-xs text-skitty-brown">
            {description}
          </p>
        )}
        {error && (
          <p id={errorId} className="text-xs text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  }
)
Input.displayName = "Input"

export { Input }