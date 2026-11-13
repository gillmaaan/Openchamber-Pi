import React from 'react';
import { cn } from '@/lib/utils';

type SidebarNavRowProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
  icon: React.ReactNode;
  label: string;
  /** Its page is open: the row takes the selection colours. */
  pressed?: boolean;
  /** The first rows of a mode, the ones used all the time, read at full strength. */
  strong?: boolean;
};

/**
 * One labelled line of the sidebar's menu: what a page or an action is called,
 * with its icon in the column the list's rows start at. Wide enough to be
 * clicked anywhere, one line like the rows below it.
 */
export const SidebarNavRow = React.forwardRef<HTMLButtonElement, SidebarNavRowProps>(function SidebarNavRow(
  { icon, label, pressed = false, strong = false, ...buttonProps },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...buttonProps}
      className={cn(
        'flex h-[30px] w-full cursor-pointer items-center gap-2 rounded-md ps-1.5 pe-2 text-start typography-ui-label focus-visible:outline-none',
        pressed
          ? 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection'
          : cn('hover:bg-interactive-hover focus-visible:bg-interactive-hover', strong ? 'text-foreground' : 'oc-title-rest hover:text-foreground'),
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate" dir="auto">{label}</span>
    </button>
  );
});
