// schemas/manual-comps.js — ace_manual_comps ↔ Airtable-style label map.
// v113.9: user-entered comparable sales (separate records, FK to subject deal).

export const SB_MANUAL_COMP_MAP = {
  id:'id', deal_id:'Deal ID',
  address:'Address', city:'City', state:'State', zip:'Zip',
  county:'County', lat:'Lat', lng:'Lng',
  sale_date:'Sale Date', price_sold:'Price Sold',
  square_feet:'Square Feet', lot_size_acres:'Lot Size (Acres)',
  property_type:'Property Type',
  owner_name:'Owner Name',
  owner_other_properties_count:'Owner Other Properties Count',
  owner_phone:'Owner Phone', owner_email:'Owner Email',
  comp_source:'Comp Source', notes:'Notes', sort_order:'Sort Order',
  created_at:'Created At', updated_at:'Updated At'
};
