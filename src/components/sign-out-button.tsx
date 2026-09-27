'use client';

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SignOutButton() {
  const router = useRouter();

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await authClient.signOut();
      if (result.error) {
        throw new Error(result.error.message ?? 'Sign out failed');
      }
    },
    onSuccess: () => {
      router.push('/sign-in');
      router.refresh();
    },
  });

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      Sign out
    </Button>
  );
}
