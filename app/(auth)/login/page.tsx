import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">아카식 레코드</h1>
          <p className="text-sm text-neutral-500">개인의 우주 도서관</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
