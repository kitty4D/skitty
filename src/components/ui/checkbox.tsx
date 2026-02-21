import * as React from "react"
import { cn } from "./utils"

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  description?: React.ReactNode;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, description, id, ...props }, ref) => {
    const checkboxId = id || props.name || React.useId();
    
    return (
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          id={checkboxId}
          ref={ref}
          className={cn(
            "rounded-none border-2 border-black text-skitty-accent focus:ring-skitty-accent focus:ring-offset-black mt-0.5 h-5 w-5 bg-white/5",
            className
          )}
          {...props}
        />
        {(label || description) && (
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            {label && (
              <label 
                htmlFor={checkboxId} 
                className="font-black text-skitty-primary block text-xs uppercase tracking-tight"
              >
                {label}
              </label>
            )}
            {description && (
              <p className="text-[10px] uppercase font-bold text-skitty-secondary/60 tracking-wider mt-0.5">{description}</p>
            )}
          </div>
        )}
      </div>
    )
  }
)
Checkbox.displayName = "Checkbox"

export { Checkbox }