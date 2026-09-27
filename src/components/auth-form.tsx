'use client';

import { useMutation } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

interface AuthFormProps {
  mode: 'sign-in' | 'sign-up';
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const result =
        mode === 'sign-in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({
              email,
              password,
              name: name || email.split('@')[0],
            });
      if (result.error) {
        throw new Error(result.error.message ?? 'Authentication failed');
      }
      return result.data;
    },
    onSuccess: () => {
      router.push('/dashboard');
      router.refresh();
    },
  });

  const isSignIn = mode === 'sign-in';

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{isSignIn ? 'Sign in' : 'Create account'}</CardTitle>
        <CardDescription>
          {isSignIn
            ? 'Sign in to your Spendium account'
            : 'Sign up to start analyzing statements'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          {!isSignIn && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                required
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              minLength={8}
              required
            />
          </div>
          {mutation.isError && (
            <p className="text-sm text-destructive">
              {mutation.error.message}
            </p>
          )}
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? 'Please wait…'
              : isSignIn
                ? 'Sign in'
                : 'Sign up'}
          </Button>
        </form>
        <p className="mt-4 text-sm text-muted-foreground">
          {isSignIn ? (
            <>
              No account?{' '}
              <Link href="/sign-up" className="underline">
                Sign up
              </Link>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <Link href="/sign-in" className="underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
