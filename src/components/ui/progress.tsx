import * as React from "react"
import { cn } from "./utils"

export interface ProgressProps
  extends React.HTMLAttributes<HTMLDivElement> {
  value: number
  max?: number
  showValue?: boolean
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, max = 100, showValue = false, ...props }, ref) => {
    const percentage = Math.min(100, (value / max) * 100)
    
    return (
      <div
        ref={ref}
        className={cn("relative", className)}
        {...props}
      >
        {showValue && (
          <div className="text-xs text-skitty-brown mb-1">
            {value} / {max}
          </div>
        )}
        <div className="h-2 w-full rounded-full bg-skitty-cream overflow-hidden">
          <div
            className="h-full bg-skitty-coral rounded-full transition-all duration-200"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
    )
  }
)
Progress.displayName = "Progress"

export { Progress }