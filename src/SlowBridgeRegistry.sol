// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

/// @title SLOW bridge registry
/// @notice Where the dapp learns which L1 route reaches which destination
///         chain, so a page frozen in bytecode can still find a rollup that did
///         not exist when it was written.
///
/// @dev WHY A REGISTRY AT ALL. The page is immutable. Bridge entrypoints are
///      proxies whose implementations get replaced, gas parameters drift, and
///      new destinations appear. Baking a route in means the page is wrong the
///      day any of that changes, and cannot be told.
///
/// @dev WHY IT CANNOT RUG YOU, which is the part that matters.
///
///      A registry an owner can rewrite is a registry that can point a bridge at
///      an address which simply keeps the ETH. So this one is deliberately weak:
///
///      1. IT STORES NO CALLDATA. Only an entrypoint address, a `kind` naming a
///         bridge FAMILY the page already knows how to talk to, and gas
///         parameters. The page builds the calldata itself from that kind. An
///         owner can therefore misdirect a route; it can never make the page
///         construct a call of the owner's choosing.
///      2. ROUTES FREEZE, one way, per chain. Once frozen the entry is
///         immutable and this contract has no say over that destination again.
///      3. THE PAGE PREFERS ITS OWN. Destinations compiled into the page are
///         used from the page; a registry entry for one of those is ignored.
///         The registry can only ADD chains the page never shipped with, so the
///         trust it carries is scoped to routes a reader opted into by using a
///         chain the page did not know about.
///
///      Ownership is two-step and renounceable. Renouncing after freezing every
///      route makes this contract inert, which is the intended end state.
contract SlowBridgeRegistry {
    /// @notice Bridge families the page knows how to build calldata for.
    /// @dev NONE is the zero value, so an unset route reads as absent rather
    ///      than as a valid family.
    enum Kind {
        NONE,
        OP_STACK, // OptimismPortal.depositTransaction(address,uint256,uint64,bool,bytes)
        ARBITRUM // Inbox.createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)
    }

    struct Route {
        address entry; // the L1 contract to call
        Kind kind; // which family, so the page knows the shape
        uint64 l2GasLimit; // gas to buy for the destination call
        bool frozen; // once true, this route can never change again
    }

    /// @notice destination chain id => route from THIS chain.
    mapping(uint256 chainId => Route) public routes;

    /// @notice Every chain id ever registered, so a reader can enumerate
    ///         without knowing what to ask for.
    uint256[] public chainIds;
    mapping(uint256 chainId => bool) private _known;

    address public owner;
    address public pendingOwner;

    error NotOwner();
    error NotPendingOwner();
    error RouteFrozen();
    error InvalidRoute();

    event RouteSet(uint256 indexed chainId, address entry, Kind kind, uint64 l2GasLimit);
    event RouteFrozenEvent(uint256 indexed chainId);
    event OwnershipOffered(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(address initialOwner) {
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner || owner == address(0)) revert NotOwner();
        _;
    }

    /// @notice Publish or correct a route to `chainId`.
    /// @dev Reverts once the route is frozen. A `kind` of NONE is rejected: use
    ///      it to mean "absent", never to mean "registered but unusable".
    function setRoute(uint256 chainId, address entry, Kind kind, uint64 l2GasLimit)
        external
        onlyOwner
    {
        Route storage r = routes[chainId];
        if (r.frozen) revert RouteFrozen();
        if (entry == address(0) || kind == Kind.NONE || chainId == 0 || l2GasLimit == 0) {
            revert InvalidRoute();
        }
        r.entry = entry;
        r.kind = kind;
        r.l2GasLimit = l2GasLimit;
        if (!_known[chainId]) {
            _known[chainId] = true;
            chainIds.push(chainId);
        }
        emit RouteSet(chainId, entry, kind, l2GasLimit);
    }

    /// @notice Make a route permanent. There is no unfreeze.
    function freezeRoute(uint256 chainId) external onlyOwner {
        Route storage r = routes[chainId];
        if (r.kind == Kind.NONE) revert InvalidRoute();
        if (r.frozen) revert RouteFrozen();
        r.frozen = true;
        emit RouteFrozenEvent(chainId);
    }

    /// @notice Every route at once, so the dapp reads this in a single call
    ///         rather than one per chain it might guess at.
    function allRoutes() external view returns (uint256[] memory ids, Route[] memory out) {
        ids = chainIds;
        out = new Route[](ids.length);
        for (uint256 i; i != ids.length; ++i) {
            out[i] = routes[ids[i]];
        }
    }

    /// @notice How many chains are registered.
    function routeCount() external view returns (uint256) {
        return chainIds.length;
    }

    // ───────────────────────────────────────────────────────── OWNERSHIP

    /// @dev Two steps, so a mistyped address cannot silently end the ability to
    ///      register anything ever again.
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(msg.sender, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || pendingOwner == address(0)) revert NotPendingOwner();
        address from = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(from, owner);
    }

    /// @notice Give up the ability to register or change any route, forever.
    /// @dev The intended end state once every route is frozen: the registry
    ///      becomes a read-only public record with nobody behind it.
    function renounceOwnership() external onlyOwner {
        address from = owner;
        owner = address(0);
        pendingOwner = address(0);
        emit OwnershipTransferred(from, address(0));
    }
}
