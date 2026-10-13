'use client';
import { AccountNav, RequireCustomer } from '@/lib/account';

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <RequireCustomer><AccountNav />{children}</RequireCustomer>;
}
