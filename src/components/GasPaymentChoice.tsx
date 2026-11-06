export function GasPaymentChoice({
  payWithWallet, onChange, disabled, requiresWalletGas, blockedReason,
}: {
  payWithWallet: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
  requiresWalletGas: boolean;
  blockedReason: string | null;
}) {
  return (
    <fieldset disabled={disabled} aria-describedby="gas-payment-help gas-payment-note" className="min-w-0 border-t border-white/20 pt-5 disabled:opacity-60">
      <legend className="float-left w-full text-lg font-bold text-white">gas payment</legend>
      <p id="gas-payment-help" className="clear-both pt-1 text-sm leading-relaxed text-white/80">
        choose who pays the network fee when you run a cleanup
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          { value: false, title: 'use sponsorship', description: "the sponsor pays gas for eligible cleanups. you don't need SUI in your wallet for those actions" },
          { value: true, title: 'pay gas with my wallet', description: "use your own SUI, including for cleanups that cost more in gas than they recover. you need SUI available before running them" },
        ].map(option => (
          <label key={String(option.value)} className={`flex gap-3 border p-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-skitty-accent ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-white/5'} ${payWithWallet === option.value ? 'border-skitty-accent bg-skitty-accent/10' : 'border-white/25'}`}>
            <input
              type="radio" name="gas-payment" value={String(option.value)}
              checked={payWithWallet === option.value} onChange={() => onChange(option.value)}
              aria-describedby={`gas-option-${String(option.value)}`}
              className="mt-1 h-4 w-4 shrink-0 accent-skitty-accent"
            />
            <span className="min-w-0">
              <span className="block text-sm font-bold text-white">{option.title}</span>
              <span id={`gas-option-${String(option.value)}`} className="mt-1 block text-sm leading-relaxed text-white/80">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      <p id="gas-payment-note" className="mt-3 max-w-prose text-sm leading-relaxed text-white/80">
        kiosk withdrawals always need your own SUI for gas. choosing an option doesn't move funds. simulate to check the cost before signing
      </p>
      <div role="status" aria-live="polite" className="mt-3 text-sm leading-relaxed">
        {requiresWalletGas && <p className="text-amber-300">this queue includes an action that requires wallet-paid gas, so your wallet pays for the whole queue</p>}
        {blockedReason && <p className="mt-1 text-amber-300">{blockedReason}</p>}
      </div>
    </fieldset>
  );
}
