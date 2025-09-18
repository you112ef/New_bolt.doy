import { forwardRef } from 'react';
import { classNames } from '~/utils/classNames';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={classNames(
        'flex h-7 w-full rounded-sm border border-bolt-elements-border bg-bolt-elements-background px-2 py-1 text-xs ring-offset-bolt-elements-background file:border-0 file:bg-transparent file:text-xs file:font-medium placeholder:text-bolt-elements-textSecondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});

Input.displayName = 'Input';

export { Input };
