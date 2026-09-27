import { AuthForm } from '@/components/auth-form';

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <AuthForm mode="sign-in" />
    </main>
  );
}
