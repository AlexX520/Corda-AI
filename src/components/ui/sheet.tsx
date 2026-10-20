'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

/**
 * Right-hand panel that opens over the list instead of a centred modal, so the banker
 * keeps their place in the queue (the pattern Front and Linear use for triage).
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sheet-overlay" />
        <DialogPrimitive.Content className="sheet" aria-describedby={undefined}>
          <header className="sheet-head">
            <div>
              <DialogPrimitive.Title className="sheet-title">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="sheet-desc">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="sheet-close" aria-label="Close">
              <X size={18} />
            </DialogPrimitive.Close>
          </header>
          <div className="sheet-body">{children}</div>
          {footer && <footer className="sheet-foot">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
