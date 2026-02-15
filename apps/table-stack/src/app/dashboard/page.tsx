import { db } from "@repo/database";
import { restaurants } from "@repo/database";
import { currentUser } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';

export default async function DashboardRootPage() {
  const user = await currentUser();
  if (!user) {
    redirect('/sign-in');
  }

  const restaurant = await db.query.restaurants.findFirst({
    where: eq(restaurants.ownerId, user.id),
  });

  if (restaurant) {
    redirect(`/dashboard/${restaurant.slug || restaurant.id}`);
  } else {
    redirect('/onboarding');
  }
}
