import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'ConferenceOS — Conference coordination, connected',
  description: 'AI-assisted capital markets conference scheduling. Human-approved, always.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
