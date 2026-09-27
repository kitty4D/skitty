# memory

current state of the parts of skitty that bite. fix these when they go stale; wrong memory is worse than none.

- [gas modes](gas-modes.md): sponsored vs self-paid gas, when each applies, and how the self-paid planner prices a batch.
- [sui gas facts](sui-gas-facts.md): verified mainnet behavior of address balances, withdrawals, simulation and rebates. the stuff that made every earlier design wrong.
- [sponsor trust boundary](sponsor-trust-boundary.md): why `/api/sponsor` validates server-side, and the attacks each gate exists to stop.
- [sui json-rpc is gone](sui-jsonrpc-removed.md): public fullnodes reject every json-rpc method; everything runs on graphql.
- [operations](operations.md): vercel env, upstash naming, funding and draining the sponsor wallet.
