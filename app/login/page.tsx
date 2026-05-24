type SearchParams = Promise<{ error?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6 bg-zinc-50 dark:bg-black">
      <form
        action="/api/login"
        method="POST"
        className="w-full max-w-sm space-y-4 rounded-xl border border-black/10 bg-white p-8 dark:border-white/10 dark:bg-zinc-950"
      >
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
            {process.env.NEXT_PUBLIC_APP_NAME ?? 'Growth Suite Dashboards'}
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Operator sign-in</p>
        </div>

        <label className="block">
          <span className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Password</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            className="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
        </label>

        {error ? (
          <p className="text-sm text-red-600 dark:text-red-400">Incorrect password.</p>
        ) : null}

        <button
          type="submit"
          className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
