import type { Metadata } from 'next';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import './v5.css';
export const metadata: Metadata = {
  title: 'Corda',
  description: 'Investor meeting coordination for capital markets desks.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
