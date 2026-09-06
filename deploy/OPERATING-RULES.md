# Operating rules for the live deployment

Everything here is a rule to follow, not a change to make. The contracts are
immutable and none of these need a redeploy — each is a property the deployment
already has, provided the thing calling it behaves.

Each rule names what it defends and what happens if it is broken.

---

## 1. An L2→L1 `arrive` message carries no bounty

**Defends:** permanent destruction of a bridged withdrawal.

`arrive`'s bounty branch calls `tx.origin`. Under EIP-7702 a finaliser can give
that address a delegation and control how much gas resolving it costs, pushing
the failure tail past the 60,000 reserve. The OP portal marks a withdrawal
finalized *before* calling and never replays it, so the ETH is gone rather than
rescued. Measured on the deployed contract: reverts across **275,000–291,000
gas** where a plain finaliser succeeds.

**Why the rule works:** `pay` derives from `bounty`, a parameter in the calldata
of the withdrawal message, fixed by whoever initiates it. The finaliser cannot
change it. At zero the branch is never entered — no divergence anywhere from
150,000 to 450,000 gas.

**Cost:** a direct L2→L1 exit into SLOW cannot pay a keeper. That is the only
shape affected. `forward` reserves 80,000 and is immune (swept, same range), so
the L2→L2 product keeps its incentive; the L1→L2 arrival the dapp builds is
immune because there the bounty credits `rescue` with no external call.

**Already satisfied by:** `SlowArrival._push` (builds a zero bounty), and the
dapp (builds no L2→L1 arrivals).

---

## 2. Relayers fill from an EOA, never a contract

**Defends:** the relayer's own payout.

`fill` records `filledBy[id] = msg.sender`, and `_release` pays that address
**on the source chain**. A relayer filling from a contract deployed only on the
destination is paid to an address it does not control where the escrow lives —
`release` is permissionless, so anyone can trigger that payment, and it is
unrecoverable.

**Why the rule works:** an EOA is the same address on every chain and the same
key controls it everywhere. `releaseTo` then also remains usable, since it
requires `msg.sender == provenBy[id]`.

**Cost:** none for an EOA relayer. A contract-based filler must hold the same
address on the source chain, which in practice means deterministic deployment
on both — the rule is simpler.

---

## 3. Senders using the relay are EOAs

**Defends:** the sender's own funds on the destination chain.

`fill` records `originOf[transferId] = i.sender`, and `reverse`/`clawback` on
the destination gate solely on `msg.sender == origin`. For a smart-contract
sender, the address says nothing about who controls it on the *other* chain: an
attacker who replays the same initcode and salt through a permissionless CREATE2
factory becomes that address on the destination and can `reverse` inside the
timelock, taking the funds. The relayer is still paid from the source escrow, so
the entire loss falls on the sender.

**Why the rule works:** an EOA cannot be replayed. The same key controls it on
every chain.

**Cost:** smart accounts cannot safely use the relay until a deployment exposes
a distinct destination-chain reverse authority. A front end should refuse an
intent whose `i.sender` holds code, rather than warn.

---

## 4. Prove a fill immediately, and push the proof promptly

**Defends:** the relayer's escrow claim.

`cancel` becomes available at `fillDeadline + PROOF_GRACE` (8 days), and
`PROOF_GRACE` is immutable with roughly 1.6 days of margin over the Nitro
challenge period. The margin absorbs the L1→L2 hop and a late keeper — it does
not absorb both plus an incident, such as an OP Guardian pausing withdrawals.

**Why the rule works:** the margin is only consumed by delay that is under the
relayer's control. Calling `proveFill` in the same run as `fill`, and
`pushProof` as soon as the exit matures, spends none of it.

**Cost:** operational discipline, not capability.

---

## 5. Guardians are addresses you control

**Defends:** the user's entire wrapped balance.

A guardian can veto rotation for ~30,000 gas an attempt, with no timeout and no
escape hatch, so a hostile guardian is a permanent freeze. This is the largest
user-facing loss surface in the system and it is entirely opt-in.

**Why the rule works:** the attack requires the victim to have appointed the
attacker. A cold wallet you hold is a guardian that cannot turn on you.

**Cost:** none. Guardianship was always meant to be a second key of your own or
a party you already trust.

---

## 6. `setApprovalForAll(gate, true)` is a full operator grant

**Defends:** informed consent, not a vulnerability.

The grant permits `withdrawFrom` and `safeTransferFrom` on the holder's
positions. It is safe only because the gate's *code* has no path to either —
verified against the live gate bytecode: immutable, no owner, no fallback, no
`delegatecall`, and its only attacker-influenced outbound call is a tip transfer
with empty calldata. "Cannot redirect funds" is true of the code, not of the
grant.

**Cost:** none, but it should be described accurately wherever it is requested.

---

## 7. Clients pin `PAGE_HASH` rather than following `successor`

**Defends:** what a reader is served.

`SlowPage.deployNext` executes arbitrary steward-supplied initcode and requires
the successor to answer only two getters, so a steward can append an upgradeable
proxy and publish under the root's accumulated trust. Separately, a successor
whose `successor()` later reverts bricks `latest()` permanently for itself and
every predecessor, including the immutable root.

**Why the rule works:** `html()` on a given version is immutable and hashes to
that version's committed `PAGE_HASH`. A client that verifies the hash it expects
is unaffected by anything appended later.

**Cost:** none for a pinned client. `renounceStewardship` closes it permanently
once the lineage is final.

---

## 8. Registry routes are frozen once set

**Defends:** value on chains the registry adds.

`setRoute` bounds `l2GasLimit` only by `!= 0`. An owner who sets it to 1 makes
every arrival on that chain run out of gas at the destination — value
destruction without touching the entrypoint. `freezeRoute` covers the gas limit
as well as the address, so freezing is a complete handback.

**Cost:** none. The registry is not yet deployed, so this is a deployment-time
rule rather than a retrofit.

---

## What none of these cover

Rules bind the code that follows them. `SlowArrival` and `SlowRelay` are
permissionless, so anyone may compose their own calls and ignore all of this.
Rules 1, 2 and 3 are the ones a third-party integrator has to be told, because
breaking them costs *them* rather than the protocol.
