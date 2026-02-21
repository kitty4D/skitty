import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-none text-xs font-black uppercase tracking-widest transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-skitty-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none active:translate-x-[1px] active:translate-y-[1px] active:shadow-none",
  {
    variants: {
      variant: {
        default: "bg-skitty-accent text-white border-2 border-black shadow-brutal hover:bg-skitty-accent/90",
        destructive: "bg-red-500 text-white border-2 border-black shadow-brutal hover:bg-red-600",
        outline: "border-2 border-skitty-accent bg-transparent text-skitty-accent hover:bg-skitty-accent hover:text-white shadow-brutal-accent",
        secondary: "bg-white text-black border-2 border-black shadow-brutal hover:bg-gray-100",
        ghost: "hover:bg-skitty-border hover:text-white",
        link: "text-skitty-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-6 py-2",
        sm: "h-9 px-4 py-1.5",
        lg: "h-14 px-8 py-4 text-sm",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }