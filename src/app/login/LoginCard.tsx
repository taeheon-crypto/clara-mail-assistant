"use client";

import { signIn } from "next-auth/react";

export default function LoginCard() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#fafafa] px-6">
      <div className="w-full max-w-[350px]">
        <div className="mb-10 flex items-center justify-center gap-2.5">
          <DotLogo />
          <span className="font-serif text-[30px] leading-none text-black">
            Clara
          </span>
        </div>

        <button
          type="button"
          onClick={() => signIn("google", { redirectTo: "/app.html" })}
          className="flex h-[43.5px] w-full items-center justify-center gap-2 bg-black/[0.03] text-[13px] font-medium text-black transition-colors hover:bg-black/[0.06]"
        >
          <GoogleIcon />
          Continue with Google
        </button>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-neutral-500">
          By continuing, you agree to our Terms of Service and Privacy
          Policy.
        </p>
      </div>
    </div>
  );
}

function DotLogo() {
  const positions = [
    [1, 0], [2, 0], [3, 0],
    [0, 1], [1, 1], [2, 1], [3, 1], [4, 1],
    [0, 2], [1, 2], [2, 2], [3, 2], [4, 2],
    [0, 3], [1, 3], [2, 3], [3, 3], [4, 3],
    [1, 4], [2, 4], [3, 4],
  ];
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
      {positions.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x * 6 + 3} cy={y * 6 + 3} r="2" fill="black" />
      ))}
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}
