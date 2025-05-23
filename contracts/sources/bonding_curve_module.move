module my_bonding_curve_package_addr::bonding_curve_module;

use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;
use sui::object::new;
use sui::transfer::{public_freeze_object, public_transfer, share_object};
use sui::tx_context::sender;

// --- Constants ---

/// Precision for price calculations to simulate decimals
const PRECISION_FOR_PRICE: u64 = 1_000_000;

/// Initial price of one token, scaled by PRECISION_FOR_PRICE
/// Corresponds to 0.0001 in Solidity example (assuming payment token has 18 decimals, this would be 0.0001 * 10^18)
/// For simplicity, we'll use a smaller number for u64 math. Let's say 100 means 0.0001
const INITIAL_PRICE_SCALED: u64 = 100; // e.g., 0.0001 * 10^6 = 100

/// Price increase per token, scaled by PRECISION_FOR_PRICE
/// Corresponds to 0.00001 in Solidity example
/// Let's say 10 means 0.00001
const PRICE_INCREASE_SCALED: u64 = 10; // e.g., 0.00001 * 10^6 = 10

// --- Errors ---
const E_PAYMENT_AMOUNT_MUST_BE_GREATER_THAN_ZERO: u64 = 1;
const E_TOKEN_AMOUNT_MUST_BE_GREATER_THAN_ZERO: u64 = 2;
const E_INSUFFICIENT_SUPPLY_FOR_SALE: u64 = 3;
const E_CALCULATED_TOKEN_AMOUNT_MUST_BE_POSITIVE: u64 = 4;

// --- Structs ---

/// The One-Time Witness for this module. Must be named uppercase version of module.
/// This struct also serves as the coin type for this bonding curve.
public struct BONDING_CURVE_MODULE has drop {}

/// Shared object representing the bonding curve state
public struct SharedTreasuryProvider has key {
    id: UID,
    cap: TreasuryCap<BONDING_CURVE_MODULE>,
}

public struct BondingCurve has key, store {
    id: UID,
    total_supply_for_pricing: u64,
    curve_id: u64,
}

// --- Events ---

public struct TokenPurchased has copy, drop {
    buyer: address,
    mock_payment_amount: u64,
    token_amount: u64,
    curve_id: u64,
}

public struct TokenSold has copy, drop {
    seller: address,
    token_amount: u64,
    mock_payment_return: u64,
    curve_id: u64,
}

// Event for new curve creation
public struct NewCurveCreated has copy, drop {
    creator: address,
    new_curve_object_id: ID,
    initial_curve_id: u64,
}

// --- Init ---

fun init(otw: BONDING_CURVE_MODULE, ctx: &mut TxContext) {
    let (treasury_cap_val, coin_metadata_obj) = coin::create_currency<BONDING_CURVE_MODULE>(
        otw,
        6,
        b"TOK",
        b"MyTok",
        b"",
        option::none(),
        ctx,
    );

    let treasury_provider = SharedTreasuryProvider {
        id: new(ctx),
        cap: treasury_cap_val,
    };
    share_object(treasury_provider);

    public_freeze_object(coin_metadata_obj);
}

// --- Factory Support Function ---
/// Creates a new BondingCurve object instance, shares it.
/// The ID of the new curve can be found in the transaction effects (created objects) or the NewCurveCreated event.
public entry fun create_new_curve(initial_curve_id: u64, ctx: &mut TxContext) {
    let curve_object = BondingCurve {
        id: new(ctx),
        total_supply_for_pricing: 0,
        curve_id: initial_curve_id,
    };
    let new_object_id = object::id(&curve_object);
    share_object(curve_object);

    event::emit(NewCurveCreated {
        creator: sender(ctx),
        new_curve_object_id: new_object_id,
        initial_curve_id: initial_curve_id,
    });
}

// --- Public View Functions (Read-only) ---

/// Calculates the current price of one token, scaled by PRECISION_FOR_PRICE.
public fun current_price_scaled(curve: &BondingCurve): u64 {
    INITIAL_PRICE_SCALED + (curve.total_supply_for_pricing * PRICE_INCREASE_SCALED)
}

/// Calculate how many tokens would be minted for a given mock payment amount.
public fun calculate_purchase_amount(curve: &BondingCurve, mock_payment_amount: u64): u64 {
    let price = current_price_scaled(curve);
    if (price == 0) { return 0 }; // Avoid division by zero, though unlikely with current constants
    (mock_payment_amount * PRECISION_FOR_PRICE) / price
}

/// Calculate the mock payment required to buy a certain amount of tokens.
public fun calculate_payment_required(curve: &BondingCurve, token_amount: u64): u64 {
    let price = current_price_scaled(curve);
    (token_amount * price) / PRECISION_FOR_PRICE
}

/// Calculate the mock payment return for selling a certain amount of tokens.
/// The price is based on the supply *before* the sale (or after, depending on interpretation).
/// For simplicity, similar to the Solidity example, we use the supply *after* the sale for calculating the return.
public fun calculate_sale_return(curve: &BondingCurve, token_amount_to_sell: u64): u64 {
    assert!(curve.total_supply_for_pricing >= token_amount_to_sell, E_INSUFFICIENT_SUPPLY_FOR_SALE);
    let supply_after_sale = curve.total_supply_for_pricing - token_amount_to_sell;
    let price_at_sale_time = INITIAL_PRICE_SCALED + (supply_after_sale * PRICE_INCREASE_SCALED);
    (token_amount_to_sell * price_at_sale_time) / PRECISION_FOR_PRICE
}

// --- Entry Functions (State-changing) ---

/// Mints BONDING_CURVE_MODULE coins to the sender based on a mock payment amount.
public entry fun buy(
    treasury_provider: &mut SharedTreasuryProvider,
    curve: &mut BondingCurve,
    mock_payment_amount: u64,
    ctx: &mut TxContext,
) {
    assert!(mock_payment_amount > 0, E_PAYMENT_AMOUNT_MUST_BE_GREATER_THAN_ZERO);

    let token_amount_to_mint = calculate_purchase_amount(curve, mock_payment_amount);
    assert!(token_amount_to_mint > 0, E_CALCULATED_TOKEN_AMOUNT_MUST_BE_POSITIVE);

    let new_coins = coin::mint(&mut treasury_provider.cap, token_amount_to_mint, ctx);
    curve.total_supply_for_pricing = curve.total_supply_for_pricing + token_amount_to_mint;
    public_transfer(new_coins, sender(ctx));

    event::emit(TokenPurchased {
        buyer: sender(ctx),
        mock_payment_amount,
        token_amount: token_amount_to_mint,
        curve_id: curve.curve_id,
    });
}

/// Burns BONDING_CURVE_MODULE coins from the sender and provides a mock payment return (event only).
public entry fun sell(
    treasury_provider: &mut SharedTreasuryProvider,
    curve: &mut BondingCurve,
    tokens_to_sell: Coin<BONDING_CURVE_MODULE>, // The actual coins to be burned
    ctx: &mut TxContext,
) {
    let token_amount_to_burn = coin::value(&tokens_to_sell);
    assert!(token_amount_to_burn > 0, E_TOKEN_AMOUNT_MUST_BE_GREATER_THAN_ZERO);
    assert!(curve.total_supply_for_pricing >= token_amount_to_burn, E_INSUFFICIENT_SUPPLY_FOR_SALE); // Ensure pricing supply is sufficient

    let mock_payment_return = calculate_sale_return(curve, token_amount_to_burn);
    // In a real scenario, you might check if mock_payment_return > 0, but here it's just for event
    // assert!(mock_payment_return > 0, E_CALCULATED_PAYMENT_RETURN_MUST_BE_POSITIVE); // Optional: depends on desired behavior

    // Burn the tokens
    coin::burn(&mut treasury_provider.cap, tokens_to_sell);

    // Update the total supply for pricing
    curve.total_supply_for_pricing = curve.total_supply_for_pricing - token_amount_to_burn;

    event::emit(TokenSold {
        seller: sender(ctx),
        token_amount: token_amount_to_burn,
        mock_payment_return,
        curve_id: curve.curve_id,
    });
}

// --- Getter Functions ---

public fun total_supply_for_pricing(curve: &BondingCurve): u64 {
    curve.total_supply_for_pricing
}

public fun get_curve_id(curve: &BondingCurve): u64 {
    curve.curve_id
}

// --- Test Only Functions for Initialization ---
#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(BONDING_CURVE_MODULE {}, ctx);
}
