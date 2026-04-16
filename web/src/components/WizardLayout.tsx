interface WizardLayoutProps {
  step: number;
  totalSteps: number;
  stepName: string;
  children: React.ReactNode;
}

export default function WizardLayout({ step, totalSteps, stepName, children }: WizardLayoutProps): React.ReactElement {
  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] px-8 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold">SoundFox</h1>
          <span className="text-[var(--text-secondary)]">Step {step} of {totalSteps}: {stepName}</span>
        </div>
      </header>
      <div className="w-full bg-[var(--bg-secondary)] h-1">
        <div className="bg-[var(--accent)] h-1 transition-all duration-500" style={{ width: `${(step / totalSteps) * 100}%` }} />
      </div>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full">{children}</div>
      </div>
    </main>
  );
}
