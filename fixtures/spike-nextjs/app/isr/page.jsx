export const revalidate = 5;

export default function IsrPage() {
  return (
    <main>
      <h1>ISR page</h1>
      <p data-testid="isr-rendered-at">isr-rendered-at:{Date.now()}</p>
    </main>
  );
}
