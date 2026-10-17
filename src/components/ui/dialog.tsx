'use client';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[#112e26]/25 backdrop-blur-[3px]" />
        <DialogPrimitive.Content
          className={cn(
            'dialog fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-stone-200 bg-white p-7 shadow-2xl',
            wide ? 'max-w-5xl' : 'max-w-xl',
          )}
        >
          <DialogPrimitive.Title className="text-xl font-semibold tracking-tight">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 mb-6 text-sm text-stone-500">
            {description || 'Review the details below.'}
          </DialogPrimitive.Description>
          <DialogPrimitive.Close
            className="absolute right-5 top-5 rounded-md p-1 text-stone-500 hover:bg-stone-100"
            aria-label="Close"
          >
            <X size={18} />
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
