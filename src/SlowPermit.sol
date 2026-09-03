// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {ReentrancyGuardTransient} from "@solady/src/utils/ReentrancyGuardTransient.sol";

/// @title SLOW permit extension
/// @notice Signature-authorised deposits: one transaction instead of two, for
///         tokens that support EIP-2612.
///
/// @dev SCOPE. This carried DAI-style and Permit2 entrypoints too. Both were
///      dropped to fit: the improved uri() render pushed the combined build 150
///      bytes past EIP-170, and of everything in it those two were the cheapest
///      to lose. No token in any of the three chains' lists uses the DAI shape,
///      and Permit2 is a convenience rung whose fallback — approve, then
///      deposit — still works and is what wallets without EIP-5792 already do.
///      The render is immutable and every holder sees it forever; a fifth
///      permit rung is not.
///
/// @dev THIS CANNOT BE A ROUTER, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
///
///      SLOW records `pendingTransfers[id].from = msg.sender` and `reverse()`
///      requires the caller to be that address (or an ERC-1155 operator it has
///      approved). A helper contract that pulled tokens by permit and then
///      called `depositTo` would make ITSELF the recorded sender: the transfer
///      would land in the helper's outbound list, and the user could never
///      reverse or claw back their own funds. That is the single property SLOW
///      exists to provide, so a permit router silently destroys the product.
///
///      Only SLOW can run the permit and keep `msg.sender` intact, which is why
///      this is an extension of the protocol contract rather than something
///      deployed beside it. The deployed SLOW at 0x0000…AaBC does not have it;
///      the dapp probes for these selectors and simply skips the rung when they
///      are absent, so one page is correct against both deployments.
///
/// @dev WHAT THIS IS NOT FOR.
///      A wallet that supports EIP-5792 atomic batching already solves this
///      without any contract change: `wallet_sendCalls([approve, depositTo])`
///      is one confirmation, atomic, with an exact allowance, and `msg.sender`
///      is the user's own account throughout. The dapp prefers that rung. These
///      functions are for wallets that cannot batch — which, on mainnet today,
///      is still most of them.
///
/// @dev A NOTE ON FRONT-RUNNING.
///      A permit signature is public once broadcast and anyone may submit it.
///      If someone else lands it first, the nonce is spent and a naive
///      `token.permit(...)` reverts — griefing the deposit even though the
///      allowance it wanted now exists. Every permit here is therefore
///      attempted, and its failure tolerated when the resulting allowance is
///      already sufficient.
abstract contract SlowPermit is ReentrancyGuardTransient {
    error PermitFailed();
    error InsufficientPermit();
    error InvalidPermitDeposit();

    // ─────────────────────────────────────────────────────── HOST HOOKS
    //
    // Implemented by SLOW. `_finishDeposit` is its existing internal — the one
    // that mints the wrapper, records the pending transfer against msg.sender,
    // and books the tip. Reusing it verbatim is what keeps `pt.from` correct.

    /// @dev Mints the wrapper and records the pending transfer. `msg.sender` is
    ///      the depositor, exactly as in the non-permit path.
    function _finishDeposit(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data
    ) internal virtual returns (uint256 transferId);

    /// @dev The host's `safeTransferFrom` for ERC-20s.
    function _pull(address token, address from, uint256 amount) internal virtual;

    // ─────────────────────────────────────────────────── EIP-2612 PERMIT

    /// @notice Deposit an ERC-20 in one transaction, authorised by an EIP-2612
    ///         signature instead of a prior `approve`.
    /// @param token    The ERC-20 being wrapped. Must not be the zero address:
    ///                 ETH needs no approval and has no permit.
    /// @param to       Recipient of the SLOW position.
    /// @param amount   Amount to wrap, in the token's own decimals.
    /// @param delay    Timelock in seconds.
    /// @param data     Passed through to the ERC-1155 receiver hook.
    /// @param deadline Signature expiry, as a unix timestamp.
    function depositToWithPermit(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        bytes calldata data,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public nonReentrant returns (uint256 transferId) {
        if (token == address(0) || amount == 0) revert InvalidPermitDeposit();
        if (to == address(0) || to == address(this)) revert InvalidPermitDeposit();
        _permit2612(token, amount, deadline, v, r, s);
        _pull(token, msg.sender, amount);
        return _finishDeposit(token, to, amount, delay, 0, data);
    }

    /// @notice `depositToWithPermit` with a keeper tip attached.
    /// @dev `msg.value` is the tip, since the wrapped asset is an ERC-20.
    function depositToWithTipAndPermit(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public payable nonReentrant returns (uint256 transferId) {
        if (token == address(0) || amount == 0 || tip == 0 || delay == 0) revert InvalidPermitDeposit();
        if (to == address(0) || to == address(this)) revert InvalidPermitDeposit();
        if (msg.value != tip) revert InvalidPermitDeposit();
        _permit2612(token, amount, deadline, v, r, s);
        _pull(token, msg.sender, amount);
        return _finishDeposit(token, to, amount, delay, tip, data);
    }

    /// @notice Raise this contract's allowance from `msg.sender` by signature,
    ///         and nothing else.
    /// @dev Exists so the permit composes with anything through the inherited
    ///      `multicall`, which delegatecalls and therefore preserves
    ///      `msg.sender`. `multicall` rejects a non-zero `msg.value`, so this
    ///      route covers ERC-20 deposits without a tip; the tipped path needs
    ///      `depositToWithTipAndPermit` above.
    function permitSelf(address token, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        public
    {
        _permit2612(token, amount, deadline, v, r, s);
    }

    /// @dev EIP-2612: `permit(owner, spender, value, deadline, v, r, s)`.
    ///      Tolerates a spent nonce when the allowance is already there.
    function _permit2612(address token, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        (bool ok,) = token.call(
            abi.encodeWithSelector(0xd505accf, msg.sender, address(this), amount, deadline, v, r, s)
        );
        if (!ok) _requireAllowance(token, amount);
    }

    /// @dev The permit call failed. It is only survivable if the allowance it
    ///      was meant to create is already in place — which is what a
    ///      front-run permit leaves behind.
    function _requireAllowance(address token, uint256 amount) internal view {
        (bool ok, bytes memory ret) = token.staticcall(
            abi.encodeWithSelector(bytes4(0xdd62ed3e), msg.sender, address(this))
        );
        if (!ok || ret.length < 32) revert PermitFailed();
        if (abi.decode(ret, (uint256)) < amount) revert InsufficientPermit();
    }
}
