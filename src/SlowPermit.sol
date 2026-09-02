// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

/// @title SLOW permit extension
/// @notice Signature-authorised deposits: one transaction instead of two, for
///         tokens that support EIP-2612, the DAI-style permit, or Permit2.
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
abstract contract SlowPermit {
    /// @dev Canonical Permit2, at the same address on every chain it is on.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

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
    ) public returns (uint256 transferId) {
        if (token == address(0) || amount == 0) revert InvalidPermitDeposit();
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
    ) public payable returns (uint256 transferId) {
        if (token == address(0) || amount == 0 || tip == 0 || delay == 0) revert InvalidPermitDeposit();
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

    // ───────────────────────────────────────────────── DAI-STYLE PERMIT

    /// @notice Deposit an ERC-20 whose `permit` predates EIP-2612 and grants an
    ///         unlimited, nonce-indexed allowance rather than an amount.
    /// @dev DAI's shape: `permit(holder, spender, nonce, expiry, allowed, v, r, s)`.
    ///      `allowed` is always true here — a signature that revoked the
    ///      allowance could not fund a deposit.
    function depositToWithDaiPermit(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        bytes calldata data,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public returns (uint256 transferId) {
        if (token == address(0) || amount == 0) revert InvalidPermitDeposit();
        (bool ok,) = token.call(
            abi.encodeWithSelector(
                bytes4(0x8fcbaf0c), msg.sender, address(this), nonce, expiry, true, v, r, s
            )
        );
        if (!ok) _requireAllowance(token, amount);
        _pull(token, msg.sender, amount);
        return _finishDeposit(token, to, amount, delay, 0, data);
    }

    // ───────────────────────────────────────────────────────── PERMIT2

    /// @notice Deposit through Permit2's signature transfer, for tokens with no
    ///         permit of their own.
    /// @dev The one rung that works for ANY ERC-20, because the signature
    ///      authorises Permit2 — which the user has usually already approved
    ///      once, for every token — rather than the token authorising SLOW.
    ///      Permit2 moves the tokens straight here, so there is no `_pull`:
    ///      this goes directly to `_finishDeposit`.
    /// @param nonce     Permit2's unordered nonce, chosen by the signer.
    /// @param deadline  Signature expiry, as a unix timestamp.
    /// @param signature The EIP-712 `PermitTransferFrom` signature.
    function depositToWithPermit2(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) public returns (uint256 transferId) {
        if (token == address(0) || amount == 0) revert InvalidPermitDeposit();
        _permit2Transfer(token, amount, nonce, deadline, signature);
        return _finishDeposit(token, to, amount, delay, 0, data);
    }

    /// @notice `depositToWithPermit2` with a keeper tip attached.
    function depositToWithTipAndPermit2(
        address token,
        address to,
        uint256 amount,
        uint96 delay,
        uint256 tip,
        bytes calldata data,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) public payable returns (uint256 transferId) {
        if (token == address(0) || amount == 0 || tip == 0 || delay == 0) revert InvalidPermitDeposit();
        if (msg.value != tip) revert InvalidPermitDeposit();
        _permit2Transfer(token, amount, nonce, deadline, signature);
        return _finishDeposit(token, to, amount, delay, tip, data);
    }

    /// @dev `permitTransferFrom(((token,amount),nonce,deadline),(to,requestedAmount),owner,signature)`.
    ///      Not tolerant of a spent nonce: unlike an allowance-granting permit,
    ///      a replayed signature transfer has already moved the tokens
    ///      somewhere, and proceeding would credit a deposit this contract was
    ///      never funded for.
    function _permit2Transfer(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        (bool ok,) = PERMIT2.call(
            abi.encodeWithSelector(
                bytes4(0x30f28b7a),
                token,
                amount,
                nonce,
                deadline,
                address(this),
                amount,
                msg.sender,
                signature
            )
        );
        if (!ok) revert PermitFailed();
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
