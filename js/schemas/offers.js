// schemas/offers.js — offer type metadata + common contingencies.
// Pure data; no DOM, no I/O. Currently duplicated in the legacy <script>
// (line ~9196); duplicate removed when the offers feature migrates.

export const _OFFER_TYPE_META = {
  asking:             { label:'Seller Asking',       color:'#1e40af', bg:'#dbeafe' },
  ace_starter:        { label:'Ace Starter',         color:'#0f766e', bg:'#ccfbf1' },
  accepted_by_seller: { label:'✓ Accepted by Seller', color:'#15803d', bg:'#d1fae5' },
  seller_counter:     { label:'Seller Counter',      color:'#b45309', bg:'#fef3c7' },
  ace_counter:        { label:'Ace Counter',         color:'#7c3aed', bg:'#ede9fe' },
  buyer_offer:        { label:'Buyer Offer',         color:'#059669', bg:'#d1fae5' },
  accepted:           { label:'✓ Final Buyer',       color:'#047857', bg:'#a7f3d0' },
  walked:             { label:'Walked',              color:'#94a3b8', bg:'#f1f5f9' }
};
