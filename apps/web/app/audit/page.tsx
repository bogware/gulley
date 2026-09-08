import { redirect } from 'next/navigation';

/** The audit view is now part of the Compliance & WORM console. */
export default function AuditRedirect() {
  redirect('/compliance');
}
