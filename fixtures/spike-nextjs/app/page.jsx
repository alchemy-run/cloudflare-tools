export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>spike-nextjs SSR page</h1>
      <p data-testid="rendered-at">rendered-at:{Date.now()}</p>
    </main>
  );
}
