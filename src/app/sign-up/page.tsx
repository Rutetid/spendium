import { AuthForm } from '@/components/auth-form';

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <AuthForm mode="sign-up" />
    </main>
  );
}
