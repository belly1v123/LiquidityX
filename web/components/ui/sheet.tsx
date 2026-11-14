"use client";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "./cn";

/**
 * Side sheet on a native <dialog>: focus trap, Esc to close and inert background come from the platform.
 * Full-width bottom-aligned on phones, right-aligned panel from sm up.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="sheet-title"
      className={cn(
        "sheet m-0 ml-auto h-dvh max-h-dvh w-full max-w-full bg-bg p-0 text-ink shadow-pop sm:w-[440px] sm:border-l sm:border-line",
        className,
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id="sheet-title" className="text-base font-semibold text-ink">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
          {footer && <footer className="border-t border-line bg-surface px-5 py-4">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
