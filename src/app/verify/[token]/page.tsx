import { db } from '@/db';
import { reservations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

export default async function VerifyPage(props: { params: Promise<{ token: string }> }) {
  const params = await props.params;
  const token = params.token;

  const reservation = await db.query.reservations.findFirst({
    where: eq(reservations.verificationToken, token),
  });

  if (!reservation) {
    notFound();
  }

  if (reservation.isVerified) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen py-2">
        <h1 className="text-4xl font-bold text-green-600">Already Verified!</h1>
        <p className="mt-4 text-xl">Your reservation is already confirmed. We look forward to seeing you!</p>
      </div>
    );
  }

  // Update verification status
  await db.update(reservations)
    .set({ isVerified: true, status: 'confirmed' })
    .where(eq(reservations.id, reservation.id));

  return (
    <div className="flex flex-col items-center justify-center min-h-screen py-2">
      <h1 className="text-4xl font-bold text-green-600">Verification Successful!</h1>
      <p className="mt-4 text-xl">Thank you, {reservation.guestName}. Your reservation is now confirmed.</p>
    </div>
  );
}
