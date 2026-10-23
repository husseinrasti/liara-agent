import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { fa } from './i18n/fa';
import './globals.css';

export const metadata: Metadata = {
  title: fa.app.title,
  description: fa.app.tagline,
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2563eb' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
