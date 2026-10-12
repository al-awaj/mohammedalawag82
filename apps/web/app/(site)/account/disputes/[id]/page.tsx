'use client';
import { use } from 'react';
import { DisputeDetailPage } from '@events/web-kit/ui';
export default function Dispute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DisputeDetailPage id={id} bookingHref={(b) => `/account/bookings/${b}`} />;
}
