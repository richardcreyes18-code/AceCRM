# /entity-lookup

Catch-all for "tell me about X" / "what about X" / "look up X" / "find X" — when the user names something but doesn't say whether it's a contact or a deal. The fetch tries both `ace_contacts` AND `ace_properties` in parallel and returns whichever has data.

## Triggered by
- *"Tell me about 409 Main Street"*
- *"Tell me about Mike Chen"*
- *"What about the Newark hotel"*
- *"Look up Atlas Capital"*
- *"Pull up 88 River Road"*
- *"Find the Elizabeth portfolio"*

## How the data comes back
The `facts` payload has both `contact_result` and `deal_result`. One or both may be `null` if no match.

```json
{
  "query": "409 Main Street",
  "contact_result": null,
  "deal_result": {
    "deal": { "label": "409 Main Street", "stage": "Asking", ... },
    "owner": { "name": "...", "company": "..." },
    ...
  }
}
```

## How to deliver it
- If only `deal_result` has data → answer like a deal snapshot.
- If only `contact_result` has data → answer like a contact lookup.
- If BOTH have data → lead with the deal (more concrete), then offer the contact in the same breath. Example: *"409 Main is at Asking, $4.2M, 28 units. The contact Mike Chen at Atlas owns it."*
- If neither → say *"Nothing on [query] in Ace"* and stop.

## Query-cleaning note
The router pre-trims the query at natural breakers (" that ", " which ", commas, " who ") so a long natural sentence like *"409 Main Street in West Orange that I added three days ago, the multifamily"* gets searched as just *"409 Main Street in West Orange"*.
